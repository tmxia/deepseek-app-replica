import { useEffect, useRef, useState } from 'react'
import { classifyApiError } from '../../services/api/errors.js'
import { fetchAccountBalance, type AccountBalance } from '../../services/api/balance.js'

export type BalanceErrorReason = 'unauthorized' | 'network' | 'other'

export type BalanceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: AccountBalance }
  | { status: 'error'; reason: BalanceErrorReason }

/**
 * 进入账号页时自动查询已保存 Key 的余额；60 秒内复用服务端缓存。
 * 手动刷新会绕过缓存并重新请求。apiKey 为空时保持 idle，不发起请求。
 */
export const useAccountBalance = (apiKey: string | null) => {
  const [state, setState] = useState<BalanceState>({ status: 'idle' })
  const [nonce, setNonce] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!apiKey) {
      setState({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setState({ status: 'loading' })
    let cancelled = false

    fetchAccountBalance(apiKey, controller.signal, nonce > 0)
      .then((data) => {
        if (!cancelled) {
          setState({ status: 'ready', data })
        }
      })
      .catch((error: unknown) => {
        if (cancelled || controller.signal.aborted) {
          return
        }
        const condition = classifyApiError(error)
        setState({
          status: 'error',
          reason:
            condition === 'unauthorized'
              ? 'unauthorized'
              : condition === 'network'
                ? 'network'
                : 'other',
        })
      })

    return () => {
      cancelled = true
      controller.abort()
      abortRef.current = null
    }
  }, [apiKey, nonce])

  const refresh = () => setNonce((value) => value + 1)

  return { state, refresh }
}
