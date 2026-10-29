'use client'

import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatMessage, ClientTableView } from '@/lib/poker/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { HandHistoryPanel } from './hand-history'

interface SidePanelProps {
  view: ClientTableView
  messages: ChatMessage[]
  onSend: (text: string) => void
}

export function SidePanel({ view, messages, onSend }: SidePanelProps) {
  const [text, setText] = useState('')
  const chatAreaRef = useRef<HTMLDivElement>(null)
  const logAreaRef = useRef<HTMLDivElement>(null)

  // Auto-scroll the panel's own viewport — NOT scrollIntoView(), which on
  // mobile also scrolls the page and would yank the player off the felt
  // every time a chat line or log entry arrives.
  const scrollToBottom = (root: HTMLDivElement | null) => {
    const vp = root?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')
    if (vp) vp.scrollTop = vp.scrollHeight
  }
  useEffect(() => {
    scrollToBottom(chatAreaRef.current)
  }, [messages.length])
  useEffect(() => {
    scrollToBottom(logAreaRef.current)
  }, [view.log.length])

  const submit = () => {
    const t = text.trim().slice(0, 200)
    if (!t) return
    onSend(t)
    setText('')
  }

  return (
    <Tabs defaultValue="chat" className="flex h-full min-h-0 flex-col gap-2">
      <TabsList className="grid w-full grid-cols-3 bg-white/5">
        <TabsTrigger value="chat" className="text-xs">Chat</TabsTrigger>
        <TabsTrigger value="log" className="text-xs">Hand log</TabsTrigger>
        <TabsTrigger value="history" className="text-xs">History</TabsTrigger>
      </TabsList>

      <TabsContent value="chat" className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
        <ScrollArea ref={chatAreaRef} className="min-h-0 flex-1 rounded-md border border-white/10 bg-black/25 p-2">
          <div className="space-y-1 pr-3">
            {messages.length === 0 && (
              <p className="py-6 text-center text-xs text-white/35">No messages yet — say hello</p>
            )}
            {messages.map((m) => (
              <p key={m.id} className={cn('text-xs leading-snug', m.system ? 'italic text-white/40' : 'text-white/80')}>
                {!m.system && <span className="font-semibold text-emerald-300">{m.name}: </span>}
                {m.text}
              </p>
            ))}
          </div>
        </ScrollArea>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message…"
            maxLength={200}
            aria-label="Chat message"
            className="h-9 bg-white/5"
          />
          <Button type="submit" size="icon" className="h-9 w-9 shrink-0 bg-emerald-700 hover:bg-emerald-600" aria-label="Send chat">
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </TabsContent>

      <TabsContent value="log" className="mt-0 min-h-0 flex-1">
        <ScrollArea ref={logAreaRef} className="h-full min-h-0 rounded-md border border-white/10 bg-black/25 p-2">
          <div className="space-y-0.5 pr-3">
            {view.log.map((line, i) => (
              <p
                key={i}
                className={cn(
                  'font-mono text-[11px] leading-relaxed',
                  line.startsWith('---') ? 'font-bold text-amber-300/80' : 'text-white/65',
                )}
              >
                {line}
              </p>
            ))}
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="history" className="mt-0 min-h-0 flex-1">
        <HandHistoryPanel view={view} />
      </TabsContent>
    </Tabs>
  )
}
