import { useEffect, useRef, useState } from 'react'

/**
 * 观察元素是否进入视口（带上下预加载缓冲）。
 * 一旦进入过视口即保持激活（once），避免来回滚动反复挂载/卸载重组件。
 * 环境不支持 IntersectionObserver 时直接视为可见，保证兜底渲染。
 */
export const useInView = <T extends HTMLElement>(rootMargin = '800px 0px') => {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || inView) {
      return
    }
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [inView, rootMargin])

  return { ref, inView }
}
