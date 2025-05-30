import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next'

export function withMethods(methods: string[], handler: NextApiHandler) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    if (!req.method || !methods.includes(req.method)) {
      return res.status(405).end()
    }

    return handler(req, res)
  }
}
