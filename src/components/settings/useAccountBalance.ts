import { useEffect, useRef, useState } from 'react'
import { classifyApiError } from '../../services/api/errors.js'
import { fetchAccountBalance, type AccountBalance } from '../../services/api/balance.js'

export type BalanceErrorReason = 'unauthorized' | 'network' | 'other'

export type BalanceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: AccountBalance; refreshing?: boolean }
  | { status: 'error'; reason: BalanceErrorReason }

/**
 * 进入账号页时自动查询已保存 Key 的余额；60 秒内复用服务端缓存。
 * 手动刷新会绕过缓存并重新请求。apiKey 为空时保持 idle，不发起请求。
 *
 * 已有旧余额时走后台静默刷新：保留旧数值与分项展示，仅置 refreshing 标志，
 * 不清空成「查询中」占位，避免刷新瞬间余额区域跳闪；首次无数据才进入 loading。
 */
export const useAccountBalance = (apiKey: string | null) => {
  const [state, setState] = useState<BalanceState>({ status: 'idle' })
  const [nonce, setNonce] = useState(0)
  const lastDataRef = useRef<AccountBalance | null>(null)
  const prevKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!apiKey) {
      lastDataRef.current = null
      prevKeyRef.current = null
      setState({ status: 'idle' })
      return
    }
    // 切换了 API Key：旧余额不属于新 Key，先丢弃再按首次加载处理。
    if (prevKeyRef.current !== apiKey) {
      lastDataRef.current = null
      prevKeyRef.current = apiKey
    }

    const controller = new AbortController()
    let cancelled = false
    const hasData = lastDataRef.current !== null

    if (hasData) {
      setState((prev) =>
        prev.status === 'ready' ? { ...prev, refreshing: true } : prev,
      )
    } else {
      setState({ status: 'loading' })
    }

    fetchAccountBalance(apiKey, controller.signal, nonce > 0)
      .then((data) => {
        if (cancelled) {
          return
        }
        lastDataRef.current = data
        setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (cancelled || controller.signal.aborted) {
          return
        }
        // 后台刷新失败：已有旧余额则保留旧值，不切到错误态覆盖展示。
        if (lastDataRef.current) {
          setState((prev) =>
            prev.status === 'ready' ? { ...prev, refreshing: false } : prev,
          )
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
    }
  }, [apiKey, nonce])

  const refresh = () => setNonce((value) => value + 1)

  return { state, refresh }
}
