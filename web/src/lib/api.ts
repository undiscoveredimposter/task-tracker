import type {
  CreateInviteBody,
  CreateListBody,
  CreateTaskBody,
  Invite,
  InvitePreview,
  ListDetail,
  ListSummary,
  Me,
  Member,
  MoveTaskBody,
  Role,
  Stats,
  UpdateListBody,
  UpdateTaskBody,
} from '@tally/shared';

/** An HTTP failure carrying its status, so callers can tell "offline" from "no". */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown when the request never reached the server at all. */
export class OfflineError extends Error {
  readonly status = 0;
  constructor() {
    super('You appear to be offline');
    this.name = 'OfflineError';
  }
}

type TokenSource = () => Promise<string | null>;

let getToken: TokenSource = async () => null;

/** Wired up once by the auth provider. */
export function setTokenSource(source: TokenSource): void {
  getToken = source;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers });
  } catch {
    // fetch only rejects on a network-level failure, which is exactly the case
    // the outbox exists for — distinguish it from a server saying no.
    throw new OfflineError();
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const body = payload as { error?: string; code?: string } | null;
    throw new ApiError(response.status, body?.error ?? 'Something went wrong', body?.code);
  }

  return payload as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const api = {
  me: () => request<Me>('/me'),

  lists: () => request<ListSummary[]>('/lists'),
  list: (id: string) => request<ListDetail>(`/lists/${id}`),
  createList: (body: CreateListBody) => request<ListDetail>('/lists', { method: 'POST', ...json(body) }),
  updateList: (id: string, body: UpdateListBody) =>
    request<ListDetail>(`/lists/${id}`, { method: 'PATCH', ...json(body) }),
  deleteList: (id: string) => request<void>(`/lists/${id}`, { method: 'DELETE' }),

  addTask: (listId: string, body: CreateTaskBody) =>
    request<ListDetail>(`/lists/${listId}/tasks`, { method: 'POST', ...json(body) }),
  updateTask: (id: string, body: UpdateTaskBody) =>
    request<void>(`/tasks/${id}`, { method: 'PATCH', ...json(body) }),
  deleteTask: (id: string) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),
  // Answers with the whole list rather than a 204: running out of room between
  // two positions makes the server renumber every task at once, so the reply is
  // the only trustworthy account of the order afterwards.
  moveTask: (id: string, body: MoveTaskBody) =>
    request<ListDetail>(`/tasks/${id}/move`, { method: 'POST', ...json(body) }),

  complete: (id: string) => request<unknown>(`/tasks/${id}/complete`, { method: 'POST' }),
  uncomplete: (id: string) => request<void>(`/tasks/${id}/complete`, { method: 'DELETE' }),

  stats: (listId: string, window: number) => request<Stats>(`/lists/${listId}/stats?window=${window}`),

  invites: (listId: string) => request<Invite[]>(`/lists/${listId}/invites`),
  createInvite: (listId: string, body: CreateInviteBody) =>
    request<Invite>(`/lists/${listId}/invites`, { method: 'POST', ...json(body) }),
  revokeInvite: (inviteId: string) => request<void>(`/invites/${inviteId}`, { method: 'DELETE' }),
  invitePreview: (token: string) => request<InvitePreview>(`/invites/token/${token}`),
  acceptInvite: (token: string) =>
    request<{ listId: string }>(`/invites/token/${token}/accept`, { method: 'POST' }),

  members: (listId: string) => request<Member[]>(`/lists/${listId}/members`),
  setMemberRole: (listId: string, userId: string, role: Exclude<Role, 'owner'>) =>
    request<void>(`/lists/${listId}/members/${userId}`, { method: 'PATCH', ...json({ role }) }),
  removeMember: (listId: string, userId: string) =>
    request<void>(`/lists/${listId}/members/${userId}`, { method: 'DELETE' }),
};
