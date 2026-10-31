'use client'

import { useEffect, useState } from 'react'
import { WifiOff } from 'lucide-react'

/**
 * Floating notice shown whenever the device loses connectivity. The offline
 * shell (service worker) keeps the app openable; the poker sockets in
 * use-poker.ts reconnect on their own once the network is back, so the
 * banner disappears on the 'online' event.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  if (!offline) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-40 flex justify-center px-4">
      <span
        role="status"
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-rose-400/30 bg-[#2a1210]/95 px-4 py-1.5 text-xs font-semibold text-rose-200 shadow-[0_8px_30px_rgba(0,0,0,0.55)] backdrop-blur"
      >
        <WifiOff className="h-3.5 w-3.5" aria-hidden />
        You&apos;re offline — tables reconnect automatically
      </span>
    </div>
  )
}
