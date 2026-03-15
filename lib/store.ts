// localStorage-based persistent state for paper trading

export interface Portfolio {
  balance: number;
  initial_balance: number;
  total_trades: number;
  winning_trades: number;
  total_pnl: number;
}

export interface Position {
  id: number;
  market_id: string;
  question: string;
  yes_price: number;
  no_price: number;
  spread: number;
  quantity: number;
  cost: number;
  status: 'open' | 'closed';
  pnl: number;
  opened_at: string;
  closed_at: string | null;
}

export interface HistoryEntry {
  timestamp: string;
  balance: number;
  total_value: number;
  pnl: number;
}

export interface ScanRecord {
  timestamp: string;
  markets_scanned: number;
  opportunities_found: number;
}

export interface Opportunity {
  market_id: string;
  question: string;
  yes_price: number;
  no_price: number;
  spread: number;
  volume: number;
  liquidity: number;
  timestamp: string;
}

export interface AppState {
  portfolio: Portfolio;
  positions: { open: Position[]; closed: Position[] };
  history: HistoryEntry[];
  scans: ScanRecord[];
  opportunities: Opportunity[];
  lastScan: ScanRecord | null;
}

const STORAGE_KEY = 'polyarb_state';

function defaultState(): AppState {
  return {
    portfolio: { balance: 10000, initial_balance: 10000, total_trades: 0, winning_trades: 0, total_pnl: 0 },
    positions: { open: [], closed: [] },
    history: [],
    scans: [],
    opportunities: [],
    lastScan: null,
  };
}

export function loadState(): AppState {
  if (typeof window === 'undefined') return defaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return JSON.parse(raw) as AppState;
  } catch {
    return defaultState();
  }
}

export function saveState(state: AppState): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage full or unavailable
  }
}

export function resetState(): AppState {
  const state = defaultState();
  saveState(state);
  return state;
}
