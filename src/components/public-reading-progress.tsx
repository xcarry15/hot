'use client'

import { useEffect, useRef } from 'react'

export default function PublicReadingProgress() {
  const progressRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let animationFrame = 0
    let resizeObserver: ResizeObserver | null = null

    function updateProgress() {
      animationFrame = 0
      const documentElement = document.documentElement
      const scrollRange = documentElement.scrollHeight - window.innerHeight
      const progress = scrollRange > 0
        ? Math.min(1, Math.max(0, window.scrollY / scrollRange))
        : 0

      if (progressRef.current) {
        progressRef.current.style.transform = `scaleX(${progress})`
      }
    }

    function scheduleUpdate() {
      if (animationFrame) return
      animationFrame = window.requestAnimationFrame(updateProgress)
    }

    scheduleUpdate()
    const readyTimer = window.setTimeout(scheduleUpdate, 0)
    window.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)
    resizeObserver = new ResizeObserver(scheduleUpdate)
    resizeObserver.observe(document.documentElement)

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame)
      window.clearTimeout(readyTimer)
      window.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
      resizeObserver?.disconnect()
    }
  }, [])

  return (
    <div className="public-reading-progress" aria-hidden="true">
      <div ref={progressRef} className="public-reading-progress__value" />
    </div>
  )
}
