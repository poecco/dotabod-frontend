import { getServerSession } from '@/lib/api/getServerSession'
import { authOptions } from '@/lib/auth'
import prisma from '@/lib/db'
import { stripe } from '@/lib/stripe-server'
import { GRACE_PERIOD_END, getSubscription, isInGracePeriod } from '@/utils/subscription'
import { Prisma, type TransactionType } from '@prisma/client'
import type { NextApiRequest, NextApiResponse } from 'next'
import type Stripe from 'stripe'

// Add crypto as a supported payment method type
type ExtendedPaymentMethodType = Stripe.Checkout.SessionCreateParams.PaymentMethodType | 'crypto'

interface CheckoutRequestBody {
  priceId: string
  period?: string
  isGift?: boolean
  paymentMethod?: string
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Authenticate user
    const session = await getServerSession(req, res, authOptions)
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    if (session.user.isImpersonating) {
      return res.status(403).json({ error: 'Unauthorized: Impersonation not allowed' })
    }

    // Parse and validate request body
    const { priceId, isGift, paymentMethod } = (await req.body) as CheckoutRequestBody
    if (!priceId) {
      return res.status(400).json({ error: 'Price ID is required' })
    }

    // Verify price and determine purchase type
    const price = await stripe.prices.retrieve(priceId)
    const isRecurring = price.type === 'recurring'
    const isLifetime = !isRecurring
    // Check if user wants to pay with crypto
    const isCryptoPayment = paymentMethod === 'crypto'

    // Handle customer and subscription logic in a transaction
    const checkoutUrl = await prisma.$transaction(
      async (tx) => {
        const customerId = await ensureCustomer(session.user, tx)
        const subscriptionData = await getSubscription(session.user.id, tx)
        return await createCheckoutSession({
          customerId,
          priceId,
          isRecurring,
          isLifetime,
          subscriptionData,
          userId: session.user.id,
          email: session.user.email ?? '',
          name: session.user.name ?? '',
          image: session.user.image ?? '',
          locale: session.user.locale ?? '',
          twitchId: session.user.twitchId ?? '',
          referer: req.headers.referer,
          isGift,
          isCryptoPayment,
          tx,
        })
      },
      {
        timeout: 30000, // Increase timeout to 30 seconds to handle gift subscription processing
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    )

    return res.status(200).json({ url: checkoutUrl })
  } catch (error) {
    console.error('Checkout creation failed:', error)
    return res.status(500).json({ error: 'Failed to create checkout session' })
  }
}

async function ensureCustomer(
  user: {
    id: string
    email?: string | null
    name?: string | null
    image?: string | null
    locale?: string | null
    twitchId?: string | null
  },
  tx: Prisma.TransactionClient,
): Promise<string> {
  // Look for any existing subscription to get a customer ID
  const subscription = await tx.subscription.findFirst({
    where: { userId: user.id },
    select: { stripeCustomerId: true },
    orderBy: { createdAt: 'desc' }, // Use the most recent subscription
  })

  let customerId = subscription?.stripeCustomerId

  // Verify existing customer
  if (customerId) {
    try {
      await stripe.customers.retrieve(customerId)
    } catch (error) {
      console.error('Invalid customer ID found:', error)
      customerId = null
    }
  }

  // Create or find customer if needed
  if (!customerId && user.email) {
    const existingCustomers = await stripe.customers.list({
      email: user.email,
      limit: 1,
    })

    if (existingCustomers.data.length > 0) {
      customerId = existingCustomers.data[0].id
    } else {
      const newCustomer = await createStripeCustomer(user)
      customerId = newCustomer.id
    }

    if (!subscription?.stripeCustomerId) {
      // Update existing subscriptions with no customer ID
      await tx.subscription.updateMany({
        where: { userId: user.id, stripeCustomerId: null },
        data: { stripeCustomerId: customerId, updatedAt: new Date() },
      })
    }
  }

  if (!customerId) {
    throw new Error('Unable to establish customer ID')
  }

  return customerId
}

async function createStripeCustomer(user: {
  id: string
  email?: string | null
  name?: string | null
  image?: string | null
  locale?: string | null
  twitchId?: string | null
}) {
  return stripe.customers.create({
    email: user.email ?? undefined,
    metadata: {
      userId: user.id,
      email: user.email ?? '',
      name: user.name ?? '',
      image: user.image ?? '',
      locale: user.locale ?? '',
      twitchId: user.twitchId ?? '',
    },
  })
}

interface CheckoutSessionParams {
  customerId: string
  priceId: string
  isRecurring: boolean
  isLifetime: boolean
  subscriptionData: {
    stripeCustomerId: string | null
    stripeSubscriptionId: string | null
    status: string | null
    stripePriceId: string | null
    transactionType: TransactionType
  } | null
  userId: string
  email: string
  name: string
  image: string
  locale: string
  twitchId: string
  referer?: string
  isGift?: boolean
  isCryptoPayment: boolean
  tx?: Prisma.TransactionClient
}

async function createCheckoutSession(params: CheckoutSessionParams): Promise<string> {
  const {
    customerId,
    priceId,
    isRecurring,
    isLifetime,
    subscriptionData,
    userId,
    email,
    name,
    image,
    locale,
    twitchId,
    referer,
    isGift,
    isCryptoPayment,
    tx,
  } = params

  // Cancel any pending crypto invoices if this is an upgrade with crypto payment
  if (isCryptoPayment && subscriptionData?.stripePriceId && tx) {
    try {
      // Get existing subscription metadata to find renewal invoice ID
      const existingSubscription = await tx.subscription.findFirst({
        where: {
          userId,
          stripeCustomerId: customerId,
          NOT: { status: 'CANCELED' },
        },
        select: {
          metadata: true,
        },
      })

      const metadata = (existingSubscription?.metadata as Record<string, unknown>) || {}
      const renewalInvoiceId = metadata.renewalInvoiceId as string

      // If there's a pending invoice, cancel it
      if (renewalInvoiceId) {
        console.log(
          `Canceling pending invoice ${renewalInvoiceId} for user ${userId} due to subscription upgrade`,
        )

        try {
          // Void the invoice to prevent it from being finalized
          await stripe.invoices.voidInvoice(renewalInvoiceId)
          console.log(`Successfully voided invoice ${renewalInvoiceId}`)
        } catch (invoiceError) {
          // If invoice is already finalized, try to mark it as uncollectible instead
          try {
            const invoice = await stripe.invoices.retrieve(renewalInvoiceId)
            if (invoice.status === 'open') {
              await stripe.invoices.markUncollectible(renewalInvoiceId)
              console.log(`Marked invoice ${renewalInvoiceId} as uncollectible`)
            }
          } catch (markError) {
            console.error(`Failed to handle invoice ${renewalInvoiceId}:`, markError)
          }
        }
      }
    } catch (error) {
      console.error('Error canceling pending invoices:', error)
      // Continue with checkout creation even if invoice cancellation fails
      // We'll handle any duplicate payments through customer support
    }
  }

  const baseUrl = process.env.NEXTAUTH_URL ?? ''

  // Calculate trial period based on grace period
  const now = new Date()

  // Simplified trial period logic
  let trialDays = 0

  if (isGift) {
    // No trial for gift purchases
    trialDays = 0
  } else if (isInGracePeriod()) {
    // If we're in the grace period, use days until grace period ends as trial
    trialDays = Math.ceil((GRACE_PERIOD_END.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
  } else if (isRecurring) {
    // Standard trial for new self-subscriptions
    trialDays = 14
  }

  if (isCryptoPayment) {
    trialDays = 0
  }

  // Build success URL with simplified parameters
  const successUrl = `${baseUrl || 'https://dotabod.com'}/dashboard?paid=true&crypto=${
    isCryptoPayment ? 'true' : 'false'
  }&trial=${isRecurring && trialDays > 0}&trialDays=${trialDays}`

  const cancelUrl = referer?.includes('/dashboard')
    ? `${baseUrl || 'https://dotabod.com'}/dashboard/billing?paid=false`
    : `${baseUrl || 'https://dotabod.com'}/?paid=false`

  // @ts-ignore crypto payment method types are not supported in the latest stripe types
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: isRecurring && !isCryptoPayment ? 'subscription' : 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    payment_method_types: isCryptoPayment ? ['crypto'] : undefined,
    subscription_data:
      isRecurring && !isCryptoPayment
        ? {
            ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
            trial_settings: {
              end_behavior: { missing_payment_method: 'cancel' },
            },
          }
        : undefined,
    allow_promotion_codes: true,
    metadata: {
      userId,
      email,
      name,
      image,
      locale,
      twitchId,
      isUpgradeToLifetime: isLifetime && subscriptionData?.stripeSubscriptionId ? 'true' : 'false',
      previousSubscriptionId: subscriptionData?.stripeSubscriptionId ?? '',
      isNewSubscription: isRecurring && !subscriptionData?.stripeSubscriptionId ? 'true' : 'false',
      isGift: isGift ? 'true' : 'false',
      isCryptoPayment: isCryptoPayment ? 'true' : 'false',
    },
  })

  return session.url ?? ''
}
