import { randomUUID } from 'node:crypto';

export type QuickAgentGroupDiscoveryScope = 'group-only' | 'mixed';

export interface QuickAgentGroupInviteMetadata {
  name?: string;
  purpose?: string;
  [key: string]: unknown;
}

export interface QuickAgentGroupInvite {
  type: 'GROUP_INVITE';
  groupId: string;
  issuedBy: string;
  createdAt: number;
  expiresAt: number;
  discoveryScope: QuickAgentGroupDiscoveryScope;
  metadata?: QuickAgentGroupInviteMetadata;
  signature: string;
}

export interface CreateQuickAgentGroupInviteInput {
  groupId?: string;
  issuedBy: string;
  createdAt?: number;
  expiresAt: number;
  discoveryScope?: QuickAgentGroupDiscoveryScope;
  metadata?: QuickAgentGroupInviteMetadata;
}

const GROUP_ID_PATTERN = /^[A-Za-z0-9_.:-]{3,128}$/;

function normalizeUnsignedInvite(input: CreateQuickAgentGroupInviteInput): Omit<QuickAgentGroupInvite, 'signature'> {
  const createdAt = input.createdAt ?? Date.now();
  const groupId = input.groupId ?? generateQuickAgentGroupId();

  if (!validateQuickAgentGroupId(groupId)) {
    throw new Error(`Invalid quick agent group ID: ${groupId}`);
  }

  if (typeof input.issuedBy !== 'string' || !input.issuedBy.startsWith('did:agent:')) {
    throw new Error('Quick agent group invites require an issuedBy DID');
  }

  if (!Number.isFinite(createdAt) || !Number.isFinite(input.expiresAt)) {
    throw new Error('Quick agent group invites require finite timestamps');
  }

  if (input.expiresAt <= createdAt) {
    throw new Error('Quick agent group invites must expire after creation');
  }

  return {
    type: 'GROUP_INVITE',
    groupId,
    issuedBy: input.issuedBy,
    createdAt,
    expiresAt: input.expiresAt,
    discoveryScope: input.discoveryScope ?? 'group-only',
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function generateQuickAgentGroupId(): string {
  return `grp_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function validateQuickAgentGroupId(groupId: string): boolean {
  return GROUP_ID_PATTERN.test(groupId);
}

export function encodeQuickAgentGroupInvitePayload(
  invite: Omit<QuickAgentGroupInvite, 'signature'>,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(invite));
}

export async function createQuickAgentGroupInvite(
  input: CreateQuickAgentGroupInviteInput,
  signFn: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<QuickAgentGroupInvite> {
  const invite = normalizeUnsignedInvite(input);
  const signature = await signFn(encodeQuickAgentGroupInvitePayload(invite));

  return {
    ...invite,
    signature: Buffer.from(signature).toString('hex'),
  };
}

export async function verifyQuickAgentGroupInvite(
  invite: QuickAgentGroupInvite,
  verifyFn: (signature: Uint8Array, data: Uint8Array) => Promise<boolean>,
): Promise<boolean> {
  if (!validateQuickAgentGroupInvite(invite)) {
    return false;
  }

  const { signature, ...payload } = invite;
  return verifyFn(Buffer.from(signature, 'hex'), encodeQuickAgentGroupInvitePayload(payload));
}

export function isQuickAgentGroupInviteExpired(
  invite: Pick<QuickAgentGroupInvite, 'expiresAt'>,
  now = Date.now(),
): boolean {
  return now >= invite.expiresAt;
}

export function validateQuickAgentGroupInvite(invite: unknown): invite is QuickAgentGroupInvite {
  if (typeof invite !== 'object' || invite === null) {
    return false;
  }

  const candidate = invite as Partial<QuickAgentGroupInvite>;
  return candidate.type === 'GROUP_INVITE'
    && typeof candidate.groupId === 'string'
    && validateQuickAgentGroupId(candidate.groupId)
    && typeof candidate.issuedBy === 'string'
    && candidate.issuedBy.startsWith('did:agent:')
    && typeof candidate.createdAt === 'number'
    && Number.isFinite(candidate.createdAt)
    && typeof candidate.expiresAt === 'number'
    && Number.isFinite(candidate.expiresAt)
    && candidate.expiresAt > candidate.createdAt
    && (candidate.discoveryScope === 'group-only' || candidate.discoveryScope === 'mixed')
    && typeof candidate.signature === 'string'
    && candidate.signature.length > 0;
}
