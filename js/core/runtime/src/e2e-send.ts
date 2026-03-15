import {
  createEnvelope,
  encodeMessage,
  encryptApplicationEnvelope,
  extractPublicKey,
  hexToBytes,
  loadLocalSession,
  sign,
  signEnvelope,
  signEncryptedTransportEnvelope,
  verifySignedPreKeyRecord,
  type AgentCard,
  type ClaimedPreKeyBundle,
  type LocalE2EConfig,
  type MessageEnvelope,
  type MessageEnvelopeType,
  type PublishedDeviceDirectoryEntry,
  type RelayClient,
} from '@quadra-a/protocol';

interface IdentityLike {
  did: string;
  publicKey: string;
  privateKey: string;
}

interface KeyPairLike {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

interface RelayClientLike extends Pick<RelayClient, 'fetchCard' | 'fetchPreKeyBundle'> {}

export interface PrepareEncryptedSendInput {
  identity: IdentityLike;
  keyPair: KeyPairLike;
  relayClient: RelayClientLike;
  e2eConfig: LocalE2EConfig;
  to: string;
  protocol: string;
  payload: Record<string, unknown>;
  type?: MessageEnvelopeType;
  replyTo?: string;
  threadId?: string;
}

export interface PreparedEncryptedSendTarget {
  outerEnvelope: MessageEnvelope;
  outerEnvelopeBytes: Uint8Array;
  transport: 'prekey' | 'session';
  senderDeviceId: string;
  recipientDeviceId: string;
  sessionId: string;
}

export interface PrepareEncryptedSendsResult {
  applicationEnvelope: MessageEnvelope;
  targets: PreparedEncryptedSendTarget[];
  e2eConfig: LocalE2EConfig;
}

export interface PrepareEncryptedSendResult {
  applicationEnvelope: MessageEnvelope;
  outerEnvelope: MessageEnvelope;
  outerEnvelopeBytes: Uint8Array;
  e2eConfig: LocalE2EConfig;
  transport: 'prekey' | 'session';
  recipientDeviceId: string;
}

function selectRecipientDevices(card: AgentCard | null, did: string): PublishedDeviceDirectoryEntry[] {
  if (!card) {
    throw new Error(`No Agent Card found for ${did}`);
  }

  const devices = Array.isArray(card.devices) ? [...card.devices] : [];
  if (devices.length === 0) {
    throw new Error(`Target ${did} does not publish any E2E devices`);
  }

  const uniqueDevices = new Map<string, PublishedDeviceDirectoryEntry>();
  for (const device of devices) {
    if (uniqueDevices.has(device.deviceId)) {
      throw new Error(`Target ${did} publishes duplicate E2E device ${device.deviceId}`);
    }
    uniqueDevices.set(device.deviceId, device);
  }

  return [...uniqueDevices.values()].sort((left, right) => left.deviceId.localeCompare(right.deviceId));
}

function selectSingleRecipientDevice(card: AgentCard | null, did: string): PublishedDeviceDirectoryEntry {
  const devices = selectRecipientDevices(card, did);
  if (devices.length > 1) {
    throw new Error(
      `Target ${did} publishes ${devices.length} E2E devices; use multi-device fan-out instead of prepareEncryptedSend`,
    );
  }
  return devices[0];
}

async function assertRecipientSignedPreKeyBundle(
  did: string,
  claimedBundle: ClaimedPreKeyBundle,
): Promise<void> {
  const isValid = await verifySignedPreKeyRecord({
    deviceId: claimedBundle.deviceId,
    signedPreKeyId: claimedBundle.signedPreKeyId,
    signedPreKeyPublic: hexToBytes(claimedBundle.signedPreKeyPublic),
    signature: hexToBytes(claimedBundle.signedPreKeySignature),
  }, extractPublicKey(did));

  if (!isValid) {
    throw new Error(`Target ${did}:${claimedBundle.deviceId} publishes invalid signed pre-key signature`);
  }
}

export async function prepareEncryptedSends(
  input: PrepareEncryptedSendInput,
): Promise<PrepareEncryptedSendsResult> {
  const unsignedEnvelope = createEnvelope(
    input.identity.did,
    input.to,
    input.type ?? 'message',
    input.protocol,
    input.payload,
    input.replyTo,
    input.threadId,
  );
  const applicationEnvelope = await signEnvelope(unsignedEnvelope, (data) => sign(data, input.keyPair.privateKey));

  const recipientCard = await input.relayClient.fetchCard(input.to);
  const recipientDevices = selectRecipientDevices(recipientCard, input.to);
  let nextE2EConfig = input.e2eConfig;
  const targets: PreparedEncryptedSendTarget[] = [];

  for (const recipientDevice of recipientDevices) {
    let existingSession = loadLocalSession(
      nextE2EConfig,
      nextE2EConfig.currentDeviceId,
      input.to,
      recipientDevice.deviceId,
    );

    // Detect stale session: if the recipient's signed pre-key changed (e.g. agent
    // restarted), the existing session is unusable. Discard it so we fall through
    // to a fresh prekey handshake.
    if (existingSession && existingSession.bootstrap?.recipientSignedPreKeyPublic) {
      const currentSpk = recipientDevice.signedPreKeyPublic;
      const sessionSpk = existingSession.role === 'initiator'
        ? existingSession.bootstrap.recipientSignedPreKeyPublic
        : undefined;
      if (sessionSpk && currentSpk && sessionSpk !== currentSpk) {
        existingSession = undefined;
      }
    }

    const claimedBundle = existingSession
      ? undefined
      : await input.relayClient.fetchPreKeyBundle(input.to, recipientDevice.deviceId);

    if (!existingSession && !claimedBundle) {
      throw new Error(`No claimed pre-key bundle available for ${input.to}:${recipientDevice.deviceId}`);
    }

    if (claimedBundle) {
      await assertRecipientSignedPreKeyBundle(input.to, claimedBundle);
    }

    const encrypted = encryptApplicationEnvelope({
      e2eConfig: nextE2EConfig,
      applicationEnvelope,
      recipientDevice,
      claimedBundle: claimedBundle ?? undefined,
    });
    nextE2EConfig = encrypted.e2eConfig;
    const outerEnvelope = await signEncryptedTransportEnvelope({
      applicationEnvelope,
      payload: encrypted.payload,
      signFn: (data) => sign(data, input.keyPair.privateKey),
    });

    targets.push({
      outerEnvelope,
      outerEnvelopeBytes: encodeMessage(outerEnvelope),
      transport: encrypted.transport,
      senderDeviceId: encrypted.payload.senderDeviceId,
      recipientDeviceId: recipientDevice.deviceId,
      sessionId: encrypted.payload.sessionId,
    });
  }

  return {
    applicationEnvelope,
    targets,
    e2eConfig: nextE2EConfig,
  };
}

export async function prepareEncryptedSend(
  input: PrepareEncryptedSendInput,
): Promise<PrepareEncryptedSendResult> {
  const recipientCard = await input.relayClient.fetchCard(input.to);
  selectSingleRecipientDevice(recipientCard, input.to);

  const prepared = await prepareEncryptedSends({
    ...input,
    relayClient: {
      fetchCard: async () => recipientCard,
      fetchPreKeyBundle: input.relayClient.fetchPreKeyBundle.bind(input.relayClient),
    },
  });
  const target = prepared.targets[0];

  return {
    applicationEnvelope: prepared.applicationEnvelope,
    outerEnvelope: target.outerEnvelope,
    outerEnvelopeBytes: target.outerEnvelopeBytes,
    e2eConfig: prepared.e2eConfig,
    transport: target.transport,
    recipientDeviceId: target.recipientDeviceId,
  };
}
