import { API_ORIGIN, request } from './client.js'

/**
 * 官方余额接口：GET /user/balance
 * 文档：https://api-docs.deepseek.com/zh-cn/api/get-user-balance
 * 返回结构为 balance_infos 数组，首项即本账号余额；同时兼容旧版平铺字段。
 * 注意：该接口只提供账号级余额，不提供单个 Key 的实时 token 消耗。
 */
export type AccountBalance = {
  /** 当前账户是否还有余额可供 API 调用 */
  isAvailable: boolean
  /** 币种：CNY / USD；缺失时为 null */
  currency: string | null
  /** 总可用余额（字符串金额，保留两位小数） */
  totalBalance: string
  /** 未过期的赠金余额 */
  grantedBalance: string
  /** 充值余额 */
  toppedUpBalance: string
}

type BalanceInfoRaw = {
  currency?: string
  total_balance?: string
  granted_balance?: string
  topped_up_balance?: string
}

type BalanceResponse = BalanceInfoRaw & {
  is_available?: boolean
  balance_infos?: BalanceInfoRaw[]
}

const CACHE_TTL = 60_000
let cached: { apiKey: string; at: number; data: AccountBalance } | null = null

const asAmount = (value: unknown): string =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : '0.00'

const normalize = (body: BalanceResponse): AccountBalance => {
  const info = body.balance_infos?.[0] ?? body
  return {
    isAvailable: body.is_available !== false,
    currency: typeof info.currency === 'string' && info.currency ? info.currency : null,
    totalBalance: asAmount(info.total_balance),
    grantedBalance: asAmount(info.granted_balance),
    toppedUpBalance: asAmount(info.topped_up_balance),
  }
}

/**
 * 查询当前 API Key 所属账号的余额。
 * 余额是账号级信息，固定请求官方服务地址，不跟随高级设置里的自定义端点。
 * force 为 true 时绕过本地缓存（用于手动刷新）。
 */
export const fetchAccountBalance = async (
  apiKey: string,
  signal?: AbortSignal,
  force = false
): Promise<AccountBalance> => {
  if (
    !force &&
    !signal &&
    cached &&
    cached.apiKey === apiKey &&
    Date.now() - cached.at < CACHE_TTL
  ) {
    return cached.data
  }
  const response = await request(`${API_ORIGIN}/user/balance`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  const body = (await response.json()) as BalanceResponse
  const data = normalize(body)
  cached = { apiKey, at: Date.now(), data }
  return data
}

/** 币种符号：人民币 ¥、美元 $；其他币种返回空串，由调用方补币种代码。 */
export const balanceCurrencySymbol = (currency: string | null): string => {
  if (currency === 'CNY') {
    return '¥'
  }
  if (currency === 'USD') {
    return '$'
  }
  return ''
}
