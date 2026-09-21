export interface Comment {
  id: string;
  author: string;
  body: string;
  created_at: string;
}

export interface SpecAnswer {
  address: string;
  verdict: string;
  note: string;
  at: string;
  blocks?: string[];
  after?: string;
}

export interface SpecSeen {
  address: string;
  hash: string;
  at: string;
  blocks?: string[];
  text?: string;
}

export interface Todo {
  id: string;
  number?: number;
  subject: string;
  description: string;
  status: string;
  priority?: string;
  kind?: string;
  change?: boolean;
  change_id?: string;
  scheduled_for?: string | null;
  plan: string;
  project?: string | null;
  from?: string | null;
  comments?: Comment[];
  links?: string[];
  depends_on?: string[];
  handoff?: string;
  spec?: string[];
  spec_answers?: SpecAnswer[];
  spec_seen?: SpecSeen[];
  ext?: Record<string, unknown>;
  imported_at?: string | null;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface BoardChange {
    id: string;
    number: number;
    title: string;
    delta?: string;
    project?: string | null;
    spec?: string[];
    budget_usd?: number;
    parallel_limit?: number;
    created_at?: string;
    updated_at?: string;
    closed_at?: string;
}
