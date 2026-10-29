-- NutsRiver — D1 schema (mirror of the SCHEMA constant in workers/store.ts)
-- NOTE: the Worker auto-applies this schema plus additive migrations on first
-- DB touch (idempotent), so running this file manually is optional. It is
-- provided for `wrangler d1 execute royal-felt --remote --file=workers/schema.sql`
-- convenience and for inspecting/migrating the database by hand.

CREATE TABLE IF NOT EXISTS User (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  chips INTEGER NOT NULL DEFAULT 10000,
  handsPlayed INTEGER NOT NULL DEFAULT 0,
  handsWon INTEGER NOT NULL DEFAULT 0,
  biggestPotWon INTEGER NOT NULL DEFAULT 0,
  lastTopupAt INTEGER,
  createdAt INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'player',
  banned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ChipTransaction (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  balanceAfter INTEGER NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_user ON ChipTransaction (userId, at);
CREATE INDEX IF NOT EXISTS idx_tx_at ON ChipTransaction (at);

CREATE TABLE IF NOT EXISTS HandHistory (
  id TEXT PRIMARY KEY,
  tableKey TEXT NOT NULL,
  handNumber INTEGER NOT NULL,
  board TEXT NOT NULL,
  potTotal INTEGER NOT NULL,
  results TEXT NOT NULL,
  participants TEXT NOT NULL DEFAULT '[]',
  log TEXT NOT NULL DEFAULT '[]',
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hand_table ON HandHistory (tableKey, handNumber);
CREATE INDEX IF NOT EXISTS idx_hand_at ON HandHistory (at);

CREATE TABLE IF NOT EXISTS SiteConfig (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS Tournament (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gameType TEXT NOT NULL,
  kind TEXT NOT NULL,
  buyIn INTEGER NOT NULL,
  bounty INTEGER NOT NULL DEFAULT 0,
  startingStack INTEGER NOT NULL,
  seatsPerTable INTEGER NOT NULL,
  maxPlayers INTEGER NOT NULL,
  startAt INTEGER,
  levelMs INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'registering',
  prizePool INTEGER NOT NULL DEFAULT 0,
  winnerUserId TEXT,
  createdAt INTEGER NOT NULL,
  finishedAt INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tournament_state ON Tournament (state, createdAt);

CREATE TABLE IF NOT EXISTS TournamentEntry (
  tournamentId TEXT NOT NULL,
  userId TEXT NOT NULL,
  registeredAt INTEGER NOT NULL,
  eliminatedAt INTEGER,
  finishPlace INTEGER,
  bountyWon INTEGER NOT NULL DEFAULT 0,
  prizeWon INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tournamentId, userId)
);

CREATE INDEX IF NOT EXISTS idx_entry_user ON TournamentEntry (userId, registeredAt);
