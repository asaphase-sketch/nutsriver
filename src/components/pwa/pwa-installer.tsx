'use client'

import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'

/**
 * Registers the offline-shell service worker and offers the install prompt
 * as a small auto-appearing pill (bottom-right, ~5s after the browser allows
 * installation). The pill never shows while a table is open (paused) and a
 * dismissal is remembered forever.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const DISMISS_KEY = 'nutsriver-install-dismissed'
const SHOW_DELAY_MS = 5000

export function PwaInstaller({ paused }: { paused: boolean }) {
  const [installEvent, setInstallEvent] = useState<InstallPromptEvent | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }

    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    if (standalone || localStorage.getItem(DISMISS_KEY) === '1') return

    let timer: ReturnType<typeof setTimeout> | undefined
    const onPrompt = (event: Event) => {
      event.preventDefault()
      setInstallEvent(event as InstallPromptEvent)
      timer = setTimeout(() => setVisible(true), SHOW_DELAY_MS)
    }
    const onInstalled = () => {
      setVisible(false)
      setInstallEvent(null)
      localStorage.removeItem(DISMISS_KEY)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
      if (timer) clearTimeout(timer)
    }
  }, [])

  async function install() {
    setVisible(false)
    await installEvent?.prompt()
    setInstallEvent(null)
  }

  function dismiss() {
    setVisible(false)
    setInstallEvent(null)
    localStorage.setItem(DISMISS_KEY, '1')
  }

  if (paused || !visible || !installEvent) return null

  return (
    <div className="fixed bottom-4 right-4 z-40 flex items-center gap-1 rounded-full border border-orange-300/25 bg-[#1c0f0b]/95 py-1.5 pl-4 pr-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.55)] backdrop-blur">
      <span className="text-xs font-semibold text-white/80">Install NutsRiver</span>
      <button
        type="button"
        onClick={install}
        className="flex items-center gap-1 rounded-full bg-gradient-to-b from-orange-400 to-orange-600 px-3 py-1 text-xs font-bold text-[#2a0f05] transition hover:from-orange-300 hover:to-orange-500"
      >
        <Download className="h-3 w-3" aria-hidden />
        Install
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install prompt"
        className="flex h-7 w-7 items-center justify-center rounded-full text-white/40 transition hover:bg-white/5 hover:text-white/70"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  )
}
