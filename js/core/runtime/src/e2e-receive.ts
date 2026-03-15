import {
  decryptApplicationEnvelope,
  type LocalE2EConfig,
  type MessageEnvelope,
} from '@quadra-a/protocol';

export interface PrepareEncryptedReceiveInput {
  receiverDid: string;
  e2eConfig: LocalE2EConfig;
  transportEnvelope: MessageEnvelope;
}

export async function prepareEncryptedReceive(input: PrepareEncryptedReceiveInput) {
  return decryptApplicationEnvelope({
    e2eConfig: input.e2eConfig,
    receiverDid: input.receiverDid,
    transportEnvelope: input.transportEnvelope,
  });
}
