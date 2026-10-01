import type {
  CreateInviteBody,
  CreateListBody,
  CreateSpaceBody,
  CreateTaskBody,
  Invite,
  InvitePreview,
  ListDetail,
  ListSummary,
  Me,
  Member,
  MoveTaskBody,
  Role,
  SpaceSummary,
  Stats,
  UpdateListBody,
  UpdateMeBody,
  UpdateSpaceBody,
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
  // No id in either path: the only account anyone may touch is their own.
  updateMe: (body: UpdateMeBody) => request<Me>('/me', { method: 'PATCH', ...json(body) }),
  deleteMe: () => request<void>('/me', { method: 'DELETE' }),

  spaces: () => request<SpaceSummary[]>('/spaces'),
  space: (id: string) => request<SpaceSummary>(`/spaces/${id}`),
  createSpace: (body: CreateSpaceBody) =>
    request<SpaceSummary>('/spaces', { method: 'POST', ...json(body) }),
  updateSpace: (id: string, body: UpdateSpaceBody) =>
    request<SpaceSummary>(`/spaces/${id}`, { method: 'PATCH', ...json(body) }),
  deleteSpace: (id: string) => request<void>(`/spaces/${id}`, { method: 'DELETE' }),

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

  // Sharing is space-level: a link lets someone into a space, and everything
  // in it comes with — see the model note at the top of shared/src/index.ts.
  invites: (spaceId: string) => request<Invite[]>(`/spaces/${spaceId}/invites`),
  createInvite: (spaceId: string, body: CreateInviteBody) =>
    request<Invite>(`/spaces/${spaceId}/invites`, { method: 'POST', ...json(body) }),
  revokeInvite: (inviteId: string) => request<void>(`/invites/${inviteId}`, { method: 'DELETE' }),
  invitePreview: (token: string) => request<InvitePreview>(`/invites/token/${token}`),
  acceptInvite: (token: string) =>
    request<{ spaceId: string }>(`/invites/token/${token}/accept`, { method: 'POST' }),

  members: (spaceId: string) => request<Member[]>(`/spaces/${spaceId}/members`),
  setMemberRole: (spaceId: string, userId: string, role: Exclude<Role, 'owner'>) =>
    request<void>(`/spaces/${spaceId}/members/${userId}`, { method: 'PATCH', ...json({ role }) }),
  removeMember: (spaceId: string, userId: string) =>
    request<void>(`/spaces/${spaceId}/members/${userId}`, { method: 'DELETE' }),
};
