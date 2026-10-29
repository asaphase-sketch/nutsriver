/** Shared types for the NutsRiver admin dashboard. */

export interface OverviewStats {
  totalUsers: number
  newUsersToday: number
  bannedUsers: number
  chipsInCirculation: number
  handsToday: number
  avgPotToday: number
  handsTotal: number
  biggestPotEver: number
}

export interface ActivityItem {
  kind: 'register' | 'hand' | 'tx'
  at: number
  text: string
  detail?: string
  amount?: number
}

export interface TableMetrics {
  tableKey: string
  name?: string
  humansSeated: number
  humansConnected: number
  botsSeated: number
  inHand: boolean
  handsPlayed: number
  avgPot: number
  sockets: number
  offline?: boolean
}

export interface OverviewData {
  stats: OverviewStats
  activity: ActivityItem[]
  tables: TableMetrics[]
  onlineNow: number
  botsActive: number
  activeTables: number
  version: string
  serverTime: string
}

export interface AdminUser {
  id: string
  username: string
  chips: number
  handsPlayed: number
  handsWon: number
  biggestPotWon: number
  role: 'player' | 'admin'
  banned: boolean
  createdAt: number
}

export interface AdminTable {
  tableKey: string
  name: string
  smallBlind: number
  bigBlind: number
  maxSeats: number
  playersSeated: number
  humansSeated: number
  inHand: boolean
  handsPlayed: number
  avgPot: number
  botOnly: boolean
}

export interface HandRow {
  id: string
  tableKey: string
  handNumber: number
  potTotal: number
  winners: string
  at: number
}

export interface HandDetail {
  id: string
  tableKey: string
  handNumber: number
  board: string
  potTotal: number
  results: { userId: string; name: string; amount: number; desc: string; cards: number[] }[]
  participants: { userId: string; name: string; committed: number; cards?: string[] }[]
  log: string[]
  at: number
}

export interface TxRow {
  username: string
  amount: number
  reason: string
  balanceAfter: number
  detail: string | null
  at: number
}

export interface AuditRow {
  id: string
  at: number
  actorName: string
  action: string
  target: string
  detail: string | null
}

export interface RobotsPolicy {
  enabled: boolean
  tableCounts: Record<string, number>
}

export interface RobotsTableState {
  tableKey: string
  target: number
  botsSeated: number
}

export interface RobotsData {
  policy: RobotsPolicy
  tables: RobotsTableState[]
}
