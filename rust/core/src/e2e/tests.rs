use super::{
    crypto::{bytes_to_hex, derive_x25519_public_key},
    messages::{
        build_prekey_message_associated_data, build_session_message_associated_data,
        decode_prekey_message, decode_session_message, decrypt_prekey_message,
        decrypt_session_message, encode_prekey_message, encode_session_message,
        encrypt_prekey_message, encrypt_session_message,
    },
    signed_pre_key::{build_signed_pre_key_payload, verify_signed_pre_key_record},
    types::{E2EMessageType, PreKeyMessage, SessionMessage},
    vectors::{get_hex, get_optional_u64, get_str, get_u64, load_vector_manifest_from_path},
    x3dh::{derive_x3dh_initiator_shared_secret, derive_x3dh_responder_shared_secret},
};
use std::path::PathBuf;

fn vectors_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test-scripts/e2e/vectors")
}

#[test]
fn loads_vector_manifest() {
    let manifest = load_vector_manifest_from_path(vectors_root().join("x3dh/basic.json"))
        .expect("manifest loads");
    assert_eq!(manifest.suite, "x3dh");
    assert_eq!(manifest.version, 1);
    assert!(!manifest.cases.is_empty());
}

#[test]
fn verifies_signed_pre_key_fixture() {
    let manifest =
        load_vector_manifest_from_path(vectors_root().join("agent-card-devices/basic.json"))
            .expect("manifest loads");
    let case = &manifest.cases[0];
    let signed_pre_key_public =
        get_hex(&case.inputs, "signedPreKeyPublic").expect("signed pre-key public");
    let signing_public = get_hex(&case.expected, "didSigningPublic").expect("did signing public");
    let signature = get_hex(&case.expected, "signedPreKeySignature").expect("signature");
    let payload = build_signed_pre_key_payload(
        get_str(&case.inputs, "deviceId").expect("deviceId"),
        get_u64(&case.inputs, "signedPreKeyId").expect("signedPreKeyId") as u32,
        &signed_pre_key_public,
    )
    .expect("payload builds");

    assert_eq!(
        bytes_to_hex(&payload),
        get_str(&case.expected, "signaturePayload").expect("signaturePayload")
    );
    let record = crate::e2e::types::SignedPreKeyRecord {
        device_id: get_str(&case.inputs, "deviceId")
            .expect("deviceId")
            .to_string(),
        signed_pre_key_id: get_u64(&case.inputs, "signedPreKeyId").expect("signedPreKeyId") as u32,
        signed_pre_key_public,
        signature,
    };
    assert!(verify_signed_pre_key_record(&record, &signing_public).expect("verification runs"));
}

#[test]
fn derives_x3dh_shared_secret_from_fixture() {
    let manifest = load_vector_manifest_from_path(vectors_root().join("x3dh/basic.json"))
        .expect("manifest loads");
    let case = &manifest.cases[0];
    let initiator_identity_private =
        get_hex(&case.inputs, "initiatorIdentityPrivate").expect("initiatorIdentityPrivate");
    let initiator_ephemeral_private =
        get_hex(&case.inputs, "initiatorEphemeralPrivate").expect("initiatorEphemeralPrivate");
    let recipient_identity_private =
        get_hex(&case.inputs, "recipientIdentityPrivate").expect("recipientIdentityPrivate");
    let recipient_signed_pre_key_private = get_hex(&case.inputs, "recipientSignedPreKeyPrivate")
        .expect("recipientSignedPreKeyPrivate");
    let recipient_one_time_pre_key_private = get_hex(&case.inputs, "recipientOneTimePreKeyPrivate")
        .expect("recipientOneTimePreKeyPrivate");

    assert_eq!(
        bytes_to_hex(
            &derive_x25519_public_key(&initiator_identity_private)
                .expect("initiator identity public")
        ),
        get_str(&case.expected, "initiatorIdentityPublic").expect("initiatorIdentityPublic")
    );
    assert_eq!(
        bytes_to_hex(
            &derive_x25519_public_key(&initiator_ephemeral_private)
                .expect("initiator ephemeral public")
        ),
        get_str(&case.expected, "initiatorEphemeralPublic").expect("initiatorEphemeralPublic")
    );
    assert_eq!(
        bytes_to_hex(
            &derive_x25519_public_key(&recipient_identity_private)
                .expect("recipient identity public")
        ),
        get_str(&case.expected, "recipientIdentityPublic").expect("recipientIdentityPublic")
    );
    assert_eq!(
        bytes_to_hex(
            &derive_x25519_public_key(&recipient_signed_pre_key_private)
                .expect("recipient signed pre-key public")
        ),
        get_str(&case.expected, "recipientSignedPreKeyPublic")
            .expect("recipientSignedPreKeyPublic")
    );
    assert_eq!(
        bytes_to_hex(
            &derive_x25519_public_key(&recipient_one_time_pre_key_private)
                .expect("recipient one-time pre-key public")
        ),
        get_str(&case.expected, "recipientOneTimePreKeyPublic")
            .expect("recipientOneTimePreKeyPublic")
    );

    let initiator_secret = derive_x3dh_initiator_shared_secret(
        &initiator_identity_private,
        &initiator_ephemeral_private,
        &get_hex(&case.expected, "recipientIdentityPublic").expect("recipientIdentityPublic"),
        &get_hex(&case.expected, "recipientSignedPreKeyPublic")
            .expect("recipientSignedPreKeyPublic"),
        Some(
            &get_hex(&case.expected, "recipientOneTimePreKeyPublic")
                .expect("recipientOneTimePreKeyPublic"),
        ),
    )
    .expect("initiator secret");
    let responder_secret = derive_x3dh_responder_shared_secret(
        &recipient_identity_private,
        &recipient_signed_pre_key_private,
        &get_hex(&case.expected, "initiatorIdentityPublic").expect("initiatorIdentityPublic"),
        &get_hex(&case.expected, "initiatorEphemeralPublic").expect("initiatorEphemeralPublic"),
        Some(&recipient_one_time_pre_key_private),
    )
    .expect("responder secret");

    let expected_secret = get_hex(&case.expected, "sharedSecret").expect("sharedSecret");
    assert_eq!(initiator_secret, expected_secret);
    assert_eq!(responder_secret, expected_secret);
}

#[test]
fn prekey_message_fixture_matches_expected_ciphertext_and_encoding() {
    let manifest = load_vector_manifest_from_path(vectors_root().join("prekey-message/basic.json"))
        .expect("manifest loads");
    let case = &manifest.cases[0];
    let message = PreKeyMessage {
        version: get_u64(&case.inputs, "version").expect("version") as u8,
        message_type: E2EMessageType::PreKeyMessage,
        sender_did: get_str(&case.inputs, "senderDid")
            .expect("senderDid")
            .to_string(),
        receiver_did: get_str(&case.inputs, "receiverDid")
            .expect("receiverDid")
            .to_string(),
        sender_device_id: get_str(&case.inputs, "senderDeviceId")
            .expect("senderDeviceId")
            .to_string(),
        receiver_device_id: get_str(&case.inputs, "receiverDeviceId")
            .expect("receiverDeviceId")
            .to_string(),
        session_id: get_str(&case.inputs, "sessionId")
            .expect("sessionId")
            .to_string(),
        message_id: get_str(&case.inputs, "messageId")
            .expect("messageId")
            .to_string(),
        initiator_identity_key: get_hex(&case.inputs, "initiatorIdentityKey")
            .expect("initiatorIdentityKey"),
        initiator_ephemeral_key: get_hex(&case.inputs, "initiatorEphemeralKey")
            .expect("initiatorEphemeralKey"),
        recipient_signed_pre_key_id: get_u64(&case.inputs, "recipientSignedPreKeyId")
            .expect("recipientSignedPreKeyId") as u32,
        recipient_one_time_pre_key_id: get_optional_u64(&case.inputs, "recipientOneTimePreKeyId")
            .map(|value| value as u32),
        nonce: get_hex(&case.inputs, "nonce").expect("nonce"),
        ciphertext: Vec::new(),
    };
    let key = get_hex(&case.inputs, "contentKey").expect("contentKey");
    let plaintext = get_hex(&case.inputs, "plaintext").expect("plaintext");
    let encrypted = encrypt_prekey_message(&message, &key, &plaintext).expect("message encrypts");
    let aad = build_prekey_message_associated_data(&encrypted).expect("aad builds");
    let encoded = encode_prekey_message(&encrypted).expect("message encodes");
    let decoded = decode_prekey_message(&encoded).expect("message decodes");
    let decrypted = decrypt_prekey_message(&decoded, &key).expect("message decrypts");

    assert_eq!(
        bytes_to_hex(&aad),
        get_str(&case.expected, "associatedData").expect("associatedData")
    );
    assert_eq!(
        bytes_to_hex(&encrypted.ciphertext),
        get_str(&case.expected, "ciphertext").expect("ciphertext")
    );
    assert_eq!(
        bytes_to_hex(&encoded),
        get_str(&case.expected, "encoded").expect("encoded")
    );
    assert_eq!(decrypted, plaintext);
}

#[test]
fn session_message_fixture_matches_expected_ciphertext_and_encoding() {
    let manifest =
        load_vector_manifest_from_path(vectors_root().join("session-message/basic.json"))
            .expect("manifest loads");
    let case = &manifest.cases[0];
    let message = SessionMessage {
        version: get_u64(&case.inputs, "version").expect("version") as u8,
        message_type: E2EMessageType::SessionMessage,
        sender_did: get_str(&case.inputs, "senderDid")
            .expect("senderDid")
            .to_string(),
        receiver_did: get_str(&case.inputs, "receiverDid")
            .expect("receiverDid")
            .to_string(),
        sender_device_id: get_str(&case.inputs, "senderDeviceId")
            .expect("senderDeviceId")
            .to_string(),
        receiver_device_id: get_str(&case.inputs, "receiverDeviceId")
            .expect("receiverDeviceId")
            .to_string(),
        session_id: get_str(&case.inputs, "sessionId")
            .expect("sessionId")
            .to_string(),
        message_id: get_str(&case.inputs, "messageId")
            .expect("messageId")
            .to_string(),
        ratchet_public_key: get_hex(&case.inputs, "ratchetPublicKey").expect("ratchetPublicKey"),
        previous_chain_length: get_u64(&case.inputs, "previousChainLength")
            .expect("previousChainLength") as u32,
        message_number: get_u64(&case.inputs, "messageNumber").expect("messageNumber") as u32,
        nonce: get_hex(&case.inputs, "nonce").expect("nonce"),
        ciphertext: Vec::new(),
    };
    let key = get_hex(&case.inputs, "contentKey").expect("contentKey");
    let plaintext = get_hex(&case.inputs, "plaintext").expect("plaintext");
    let encrypted = encrypt_session_message(&message, &key, &plaintext).expect("message encrypts");
    let aad = build_session_message_associated_data(&encrypted).expect("aad builds");
    let encoded = encode_session_message(&encrypted).expect("message encodes");
    let decoded = decode_session_message(&encoded).expect("message decodes");
    let decrypted = decrypt_session_message(&decoded, &key).expect("message decrypts");

    assert_eq!(
        bytes_to_hex(&aad),
        get_str(&case.expected, "associatedData").expect("associatedData")
    );
    assert_eq!(
        bytes_to_hex(&encrypted.ciphertext),
        get_str(&case.expected, "ciphertext").expect("ciphertext")
    );
    assert_eq!(
        bytes_to_hex(&encoded),
        get_str(&case.expected, "encoded").expect("encoded")
    );
    assert_eq!(decrypted, plaintext);
}

#[test]
fn double_ratchet_fixture_matches_bootstrap_and_dh_reply() {
    let manifest = load_vector_manifest_from_path(vectors_root().join("double-ratchet/basic.json"))
        .expect("manifest loads");
    let case = &manifest.cases[0];
    let shared_secret = get_hex(&case.inputs, "sharedSecret").expect("sharedSecret");
    let initiator_ratchet_private =
        get_hex(&case.inputs, "initiatorRatchetPrivate").expect("initiatorRatchetPrivate");
    let responder_ratchet_private =
        get_hex(&case.inputs, "responderRatchetPrivate").expect("responderRatchetPrivate");
    let responder_reply_ratchet_private = get_hex(&case.inputs, "responderReplyRatchetPrivate")
        .expect("responderReplyRatchetPrivate");
    let initiator_ratchet_public =
        derive_x25519_public_key(&initiator_ratchet_private).expect("initiator ratchet public");
    let responder_ratchet_public =
        derive_x25519_public_key(&responder_ratchet_private).expect("responder ratchet public");
    let responder_reply_ratchet_public = derive_x25519_public_key(&responder_reply_ratchet_private)
        .expect("responder reply ratchet public");
    let created_at = get_u64(&case.inputs, "createdAt").expect("createdAt");
    let initiator_first_plaintext =
        get_hex(&case.inputs, "initiatorFirstPlaintext").expect("initiatorFirstPlaintext");
    let initiator_first_nonce =
        get_hex(&case.inputs, "initiatorFirstNonce").expect("initiatorFirstNonce");
    let responder_reply_plaintext =
        get_hex(&case.inputs, "responderReplyPlaintext").expect("responderReplyPlaintext");
    let responder_reply_nonce =
        get_hex(&case.inputs, "responderReplyNonce").expect("responderReplyNonce");

    assert_eq!(
        bytes_to_hex(&initiator_ratchet_public),
        get_str(&case.expected, "initiatorRatchetPublic").expect("initiatorRatchetPublic")
    );
    assert_eq!(
        bytes_to_hex(&responder_ratchet_public),
        get_str(&case.expected, "responderRatchetPublic").expect("responderRatchetPublic")
    );
    assert_eq!(
        bytes_to_hex(&responder_reply_ratchet_public),
        get_str(&case.expected, "responderReplyRatchetPublic")
            .expect("responderReplyRatchetPublic")
    );

    let initiator_session =
        crate::e2e::create_initiator_ratchet_session(crate::e2e::CreateRatchetSessionInput {
            session_id: get_str(&case.inputs, "sessionId")
                .expect("sessionId")
                .to_string(),
            peer_did: get_str(&case.inputs, "responderDid")
                .expect("responderDid")
                .to_string(),
            peer_device_id: get_str(&case.inputs, "responderDeviceId")
                .expect("responderDeviceId")
                .to_string(),
            self_device_id: get_str(&case.inputs, "initiatorDeviceId")
                .expect("initiatorDeviceId")
                .to_string(),
            role: "initiator".to_string(),
            root_key: shared_secret.clone(),
            current_ratchet_key: crate::e2e::X25519KeyPair {
                public_key: initiator_ratchet_public.clone(),
                private_key: initiator_ratchet_private
                    .clone()
                    .try_into()
                    .expect("initiator ratchet private length"),
            },
            remote_ratchet_public_key: responder_ratchet_public.to_vec(),
            bootstrap: crate::e2e::LocalSessionBootstrapState {
                self_identity_key: get_str(&case.inputs, "initiatorIdentityPublic")
                    .expect("initiatorIdentityPublic")
                    .to_string(),
                peer_identity_key: get_str(&case.inputs, "responderIdentityPublic")
                    .expect("responderIdentityPublic")
                    .to_string(),
                initiator_ephemeral_key: bytes_to_hex(&initiator_ratchet_public),
                recipient_signed_pre_key_id: get_u64(&case.inputs, "responderSignedPreKeyId")
                    .expect("responderSignedPreKeyId")
                    as u32,
                recipient_signed_pre_key_public: bytes_to_hex(&responder_ratchet_public),
                recipient_one_time_pre_key_id: Some(
                    get_u64(&case.inputs, "responderOneTimePreKeyId")
                        .expect("responderOneTimePreKeyId") as u32,
                ),
            },
            created_at,
        })
        .expect("initiator ratchet session");
    let responder_session =
        crate::e2e::create_responder_ratchet_session(crate::e2e::CreateRatchetSessionInput {
            session_id: get_str(&case.inputs, "sessionId")
                .expect("sessionId")
                .to_string(),
            peer_did: get_str(&case.inputs, "initiatorDid")
                .expect("initiatorDid")
                .to_string(),
            peer_device_id: get_str(&case.inputs, "initiatorDeviceId")
                .expect("initiatorDeviceId")
                .to_string(),
            self_device_id: get_str(&case.inputs, "responderDeviceId")
                .expect("responderDeviceId")
                .to_string(),
            role: "responder".to_string(),
            root_key: shared_secret,
            current_ratchet_key: crate::e2e::X25519KeyPair {
                public_key: responder_ratchet_public.clone(),
                private_key: responder_ratchet_private
                    .clone()
                    .try_into()
                    .expect("responder ratchet private length"),
            },
            remote_ratchet_public_key: initiator_ratchet_public.to_vec(),
            bootstrap: crate::e2e::LocalSessionBootstrapState {
                self_identity_key: get_str(&case.inputs, "responderIdentityPublic")
                    .expect("responderIdentityPublic")
                    .to_string(),
                peer_identity_key: get_str(&case.inputs, "initiatorIdentityPublic")
                    .expect("initiatorIdentityPublic")
                    .to_string(),
                initiator_ephemeral_key: bytes_to_hex(&initiator_ratchet_public),
                recipient_signed_pre_key_id: get_u64(&case.inputs, "responderSignedPreKeyId")
                    .expect("responderSignedPreKeyId")
                    as u32,
                recipient_signed_pre_key_public: bytes_to_hex(&responder_ratchet_public),
                recipient_one_time_pre_key_id: Some(
                    get_u64(&case.inputs, "responderOneTimePreKeyId")
                        .expect("responderOneTimePreKeyId") as u32,
                ),
            },
            created_at,
        })
        .expect("responder ratchet session");

    assert_eq!(
        initiator_session.root_key,
        get_str(&case.expected, "initiatorInitialRootKey").expect("initiatorInitialRootKey")
    );
    assert_eq!(
        initiator_session.sending_chain_key.as_deref(),
        Some(
            get_str(&case.expected, "initiatorInitialSendingChainKey")
                .expect("initiatorInitialSendingChainKey")
        )
    );
    assert_eq!(
        responder_session.root_key,
        get_str(&case.expected, "responderInitialRootKey").expect("responderInitialRootKey")
    );
    assert_eq!(
        responder_session.receiving_chain_key.as_deref(),
        Some(
            get_str(&case.expected, "responderInitialReceivingChainKey")
                .expect("responderInitialReceivingChainKey")
        )
    );

    let initiator_first = crate::e2e::encrypt_ratchet_message(crate::e2e::RatchetEncryptInput {
        session: &initiator_session,
        plaintext: &initiator_first_plaintext,
        sender_did: get_str(&case.inputs, "initiatorDid").expect("initiatorDid"),
        receiver_did: get_str(&case.inputs, "responderDid").expect("responderDid"),
        message_id: Some(
            get_str(&case.inputs, "initiatorFirstMessageId")
                .expect("initiatorFirstMessageId")
                .to_string(),
        ),
        nonce: Some(initiator_first_nonce),
        ratchet_keypair: None,
        now: Some(created_at + 10),
    })
    .expect("initiator first ratchet message");

    assert_eq!(
        bytes_to_hex(&initiator_first.message.ratchet_public_key),
        get_str(&case.expected, "initiatorRatchetPublic").expect("initiatorRatchetPublic")
    );
    assert_eq!(
        initiator_first.message.message_number,
        get_u64(&case.expected, "initiatorFirstMessageNumber").expect("initiatorFirstMessageNumber")
            as u32
    );
    assert_eq!(
        initiator_first.message.previous_chain_length,
        get_u64(&case.expected, "initiatorFirstPreviousChainLength")
            .expect("initiatorFirstPreviousChainLength") as u32
    );
    assert_eq!(
        bytes_to_hex(&initiator_first.message_key),
        get_str(&case.expected, "initiatorFirstMessageKey").expect("initiatorFirstMessageKey")
    );
    assert_eq!(
        bytes_to_hex(&initiator_first.message.ciphertext),
        get_str(&case.expected, "initiatorFirstCiphertext").expect("initiatorFirstCiphertext")
    );
    assert_eq!(
        initiator_first.session.sending_chain_key.as_deref(),
        Some(
            get_str(&case.expected, "initiatorAfterFirstSendingChainKey")
                .expect("initiatorAfterFirstSendingChainKey")
        )
    );

    let responder_after_first =
        crate::e2e::decrypt_ratchet_message(crate::e2e::RatchetDecryptInput {
            session: &responder_session,
            message: &initiator_first.message,
            now: Some(created_at + 20),
        })
        .expect("responder decrypts first ratchet message");

    assert_eq!(responder_after_first.plaintext, initiator_first_plaintext);
    assert_eq!(
        bytes_to_hex(&responder_after_first.message_key),
        get_str(&case.expected, "initiatorFirstMessageKey").expect("initiatorFirstMessageKey")
    );
    assert_eq!(
        responder_after_first.session.receiving_chain_key.as_deref(),
        Some(
            get_str(&case.expected, "responderAfterFirstReceivingChainKey")
                .expect("responderAfterFirstReceivingChainKey")
        )
    );
    assert_eq!(
        responder_after_first.session.next_receive_message_number,
        get_u64(
            &case.expected,
            "responderAfterFirstNextReceiveMessageNumber"
        )
        .expect("responderAfterFirstNextReceiveMessageNumber") as u32
    );

    let responder_reply = crate::e2e::encrypt_ratchet_message(crate::e2e::RatchetEncryptInput {
        session: &responder_after_first.session,
        plaintext: &responder_reply_plaintext,
        sender_did: get_str(&case.inputs, "responderDid").expect("responderDid"),
        receiver_did: get_str(&case.inputs, "initiatorDid").expect("initiatorDid"),
        message_id: Some(
            get_str(&case.inputs, "responderReplyMessageId")
                .expect("responderReplyMessageId")
                .to_string(),
        ),
        nonce: Some(responder_reply_nonce),
        ratchet_keypair: Some(crate::e2e::X25519KeyPair {
            public_key: responder_reply_ratchet_public.clone(),
            private_key: responder_reply_ratchet_private
                .try_into()
                .expect("responder reply ratchet private length"),
        }),
        now: Some(created_at + 30),
    })
    .expect("responder ratchet reply");

    assert_eq!(
        bytes_to_hex(&responder_reply.message.ratchet_public_key),
        get_str(&case.expected, "responderReplyRatchetPublic")
            .expect("responderReplyRatchetPublic")
    );
    assert_eq!(
        responder_reply.message.message_number,
        get_u64(&case.expected, "responderReplyMessageNumber").expect("responderReplyMessageNumber")
            as u32
    );
    assert_eq!(
        responder_reply.message.previous_chain_length,
        get_u64(&case.expected, "responderReplyPreviousChainLength")
            .expect("responderReplyPreviousChainLength") as u32
    );
    assert_eq!(
        responder_reply.session.root_key,
        get_str(&case.expected, "responderReplyRootKey").expect("responderReplyRootKey")
    );
    assert_eq!(
        responder_reply.session.sending_chain_key.as_deref(),
        Some(
            get_str(&case.expected, "responderReplySendingChainKeyAfter")
                .expect("responderReplySendingChainKeyAfter")
        )
    );
    assert_eq!(
        bytes_to_hex(&responder_reply.message_key),
        get_str(&case.expected, "responderReplyMessageKey").expect("responderReplyMessageKey")
    );
    assert_eq!(
        bytes_to_hex(&responder_reply.message.ciphertext),
        get_str(&case.expected, "responderReplyCiphertext").expect("responderReplyCiphertext")
    );

    let initiator_after_reply =
        crate::e2e::decrypt_ratchet_message(crate::e2e::RatchetDecryptInput {
            session: &initiator_first.session,
            message: &responder_reply.message,
            now: Some(created_at + 40),
        })
        .expect("initiator decrypts responder ratchet reply");

    assert_eq!(initiator_after_reply.plaintext, responder_reply_plaintext);
    assert_eq!(
        bytes_to_hex(&initiator_after_reply.message_key),
        get_str(&case.expected, "responderReplyMessageKey").expect("responderReplyMessageKey")
    );
    assert_eq!(
        initiator_after_reply.session.root_key,
        get_str(&case.expected, "initiatorAfterReplyRootKey").expect("initiatorAfterReplyRootKey")
    );
    assert_eq!(
        initiator_after_reply.session.receiving_chain_key.as_deref(),
        Some(
            get_str(&case.expected, "initiatorAfterReplyReceivingChainKey")
                .expect("initiatorAfterReplyReceivingChainKey")
        )
    );
    assert_eq!(
        initiator_after_reply.session.next_receive_message_number,
        get_u64(
            &case.expected,
            "initiatorAfterReplyNextReceiveMessageNumber"
        )
        .expect("initiatorAfterReplyNextReceiveMessageNumber") as u32
    );
    assert_eq!(
        initiator_after_reply.session.remote_ratchet_public_key,
        get_str(&case.expected, "initiatorAfterReplyRemoteRatchetPublicKey")
            .expect("initiatorAfterReplyRemoteRatchetPublicKey")
    );
}

#[test]
fn creates_local_e2e_config_and_published_device_directory() {
    let signing_keypair = crate::identity::KeyPair::generate();
    let e2e = crate::e2e::create_initial_local_e2e_config(&signing_keypair)
        .expect("local e2e config builds");
    let device = crate::e2e::current_device_state(&e2e).expect("current device exists");
    let published = crate::e2e::build_published_device_directory(&e2e);
    let signing_public = signing_keypair.verifying_key.as_bytes().to_vec();

    assert_eq!(published.len(), 1);
    assert_eq!(published[0].device_id, e2e.current_device_id);
    assert_eq!(published[0].one_time_pre_key_count, 16);
    assert_eq!(device.one_time_pre_keys.len(), 16);

    let record = crate::e2e::SignedPreKeyRecord {
        device_id: published[0].device_id.clone(),
        signed_pre_key_id: published[0].signed_pre_key_id,
        signed_pre_key_public: hex::decode(&published[0].signed_pre_key_public)
            .expect("decode signed pre-key public"),
        signature: hex::decode(&published[0].signed_pre_key_signature)
            .expect("decode signed pre-key signature"),
    };

    assert!(verify_signed_pre_key_record(&record, &signing_public).expect("signature verifies"));
}

#[test]
fn builds_and_consumes_prekey_message_with_otk() {
    let alice_signing = crate::identity::KeyPair::generate();
    let bob_signing = crate::identity::KeyPair::generate();
    let alice_e2e = crate::e2e::create_initial_local_e2e_config(&alice_signing)
        .expect("alice local e2e config builds");
    let bob_e2e = crate::e2e::create_initial_local_e2e_config(&bob_signing)
        .expect("bob local e2e config builds");
    let bob_device = crate::e2e::build_published_device_directory(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob device");
    let bob_bundle = crate::e2e::build_published_pre_key_bundles(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob bundle");
    let claimed_bundle = crate::e2e::build_claimed_pre_key_bundle(
        &bob_bundle,
        bob_bundle.one_time_pre_keys.first().cloned(),
    );
    let plaintext = br#"{\"protocol\":\"/agent/msg/1.0.0\",\"payload\":{\"text\":\"hello\"}}"#;
    let ephemeral_keypair = crate::e2e::generate_x25519_key_pair();

    let initiator =
        crate::e2e::build_initiator_pre_key_message(crate::e2e::BuildInitiatorPreKeyMessageInput {
            e2e: &alice_e2e,
            sender_did: "did:agent:alice",
            receiver_did: "did:agent:bob",
            recipient_device: &bob_device,
            claimed_bundle: &claimed_bundle,
            plaintext,
            session_id: Some("session-otk".to_string()),
            message_id: Some("msg-otk".to_string()),
            nonce: Some(vec![7u8; 24]),
            ephemeral_keypair: Some(ephemeral_keypair.clone()),
            now: Some(100),
        })
        .expect("initiator pre-key message builds");
    let responder = crate::e2e::consume_responder_pre_key_message(
        crate::e2e::ConsumeResponderPreKeyMessageInput {
            e2e: &bob_e2e,
            receiver_did: "did:agent:bob",
            message: &initiator.message,
            now: Some(200),
        },
    )
    .expect("responder pre-key message consumes");

    assert_eq!(responder.plaintext, plaintext);
    assert_eq!(initiator.shared_secret, responder.shared_secret);
    assert_eq!(initiator.session.root_key, responder.session.root_key);
    assert_eq!(
        initiator.message.recipient_one_time_pre_key_id,
        claimed_bundle
            .one_time_pre_key
            .as_ref()
            .map(|key| key.key_id)
    );

    let stored_initiator = crate::e2e::load_local_session(
        &initiator.e2e,
        &initiator.e2e.current_device_id,
        "did:agent:bob",
        &claimed_bundle.device_id,
    )
    .expect("load initiator session");
    let stored_responder = crate::e2e::load_local_session(
        &responder.e2e,
        &responder.e2e.current_device_id,
        "did:agent:alice",
        &initiator.message.sender_device_id,
    )
    .expect("load responder session");

    assert_eq!(stored_initiator, Some(initiator.session.clone()));
    assert_eq!(stored_responder, Some(responder.session.clone()));
    assert_eq!(
        responder
            .e2e
            .devices
            .get(&responder.e2e.current_device_id)
            .expect("current responder device")
            .one_time_pre_keys
            .iter()
            .find(|key| key.key_id
                == claimed_bundle
                    .one_time_pre_key
                    .as_ref()
                    .expect("claimed key")
                    .key_id)
            .and_then(|key| key.claimed_at),
        Some(200)
    );
}

#[test]
fn supports_prekey_message_no_otk_fallback() {
    let alice_signing = crate::identity::KeyPair::generate();
    let bob_signing = crate::identity::KeyPair::generate();
    let alice_e2e = crate::e2e::create_initial_local_e2e_config(&alice_signing)
        .expect("alice local e2e config builds");
    let bob_e2e = crate::e2e::create_initial_local_e2e_config(&bob_signing)
        .expect("bob local e2e config builds");
    let bob_device = crate::e2e::build_published_device_directory(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob device");
    let bob_bundle = crate::e2e::build_published_pre_key_bundles(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob bundle");
    let claimed_bundle = crate::e2e::build_claimed_pre_key_bundle(&bob_bundle, None);
    let plaintext = b"hello-without-otk";

    let initiator =
        crate::e2e::build_initiator_pre_key_message(crate::e2e::BuildInitiatorPreKeyMessageInput {
            e2e: &alice_e2e,
            sender_did: "did:agent:alice",
            receiver_did: "did:agent:bob",
            recipient_device: &bob_device,
            claimed_bundle: &claimed_bundle,
            plaintext,
            session_id: Some("session-no-otk".to_string()),
            message_id: Some("msg-no-otk".to_string()),
            nonce: None,
            ephemeral_keypair: None,
            now: Some(300),
        })
        .expect("initiator pre-key fallback builds");
    let responder = crate::e2e::consume_responder_pre_key_message(
        crate::e2e::ConsumeResponderPreKeyMessageInput {
            e2e: &bob_e2e,
            receiver_did: "did:agent:bob",
            message: &initiator.message,
            now: Some(400),
        },
    )
    .expect("responder pre-key fallback consumes");

    assert_eq!(initiator.message.recipient_one_time_pre_key_id, None);
    assert_eq!(responder.plaintext, plaintext);
    assert_eq!(initiator.session.root_key, responder.session.root_key);
    assert!(responder
        .e2e
        .devices
        .get(&responder.e2e.current_device_id)
        .expect("current responder device")
        .one_time_pre_keys
        .iter()
        .all(|key| key.claimed_at.is_none()));
}

#[test]
fn continues_ratchet_session_and_handles_responder_dh_reply() {
    let alice_signing = crate::identity::KeyPair::generate();
    let bob_signing = crate::identity::KeyPair::generate();
    let alice_e2e = crate::e2e::create_initial_local_e2e_config(&alice_signing)
        .expect("alice local e2e config builds");
    let bob_e2e = crate::e2e::create_initial_local_e2e_config(&bob_signing)
        .expect("bob local e2e config builds");
    let bob_device = crate::e2e::build_published_device_directory(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob device");
    let bob_bundle = crate::e2e::build_published_pre_key_bundles(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob bundle");
    let bootstrap =
        crate::e2e::build_initiator_pre_key_message(crate::e2e::BuildInitiatorPreKeyMessageInput {
            e2e: &alice_e2e,
            sender_did: "did:agent:alice",
            receiver_did: "did:agent:bob",
            recipient_device: &bob_device,
            claimed_bundle: &crate::e2e::build_claimed_pre_key_bundle(
                &bob_bundle,
                bob_bundle.one_time_pre_keys.first().cloned(),
            ),
            plaintext: b"bootstrap",
            session_id: Some("session-ratchet".to_string()),
            message_id: Some("msg-bootstrap".to_string()),
            nonce: None,
            ephemeral_keypair: None,
            now: Some(100),
        })
        .expect("build bootstrap message");
    let bootstrap_receive = crate::e2e::consume_responder_pre_key_message(
        crate::e2e::ConsumeResponderPreKeyMessageInput {
            e2e: &bob_e2e,
            receiver_did: "did:agent:bob",
            message: &bootstrap.message,
            now: Some(110),
        },
    )
    .expect("consume bootstrap message");

    let alice_send = crate::e2e::encrypt_ratchet_message(crate::e2e::RatchetEncryptInput {
        session: &bootstrap.session,
        plaintext: b"alice-1",
        sender_did: "did:agent:alice",
        receiver_did: "did:agent:bob",
        message_id: Some("msg-alice-1".to_string()),
        nonce: Some(vec![1u8; 24]),
        ratchet_keypair: None,
        now: Some(120),
    })
    .expect("encrypt alice ratchet message");
    let bob_receive = crate::e2e::decrypt_ratchet_message(crate::e2e::RatchetDecryptInput {
        session: &bootstrap_receive.session,
        message: &alice_send.message,
        now: Some(130),
    })
    .expect("decrypt alice ratchet message");

    assert_eq!(bob_receive.plaintext, b"alice-1");
    assert_eq!(bob_receive.message_key, alice_send.message_key);
    assert_eq!(bob_receive.session.next_receive_message_number, 1);

    let responder_ratchet_private =
        hex::decode("c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf")
            .expect("decode responder ratchet private");
    let responder_ratchet_public = derive_x25519_public_key(&responder_ratchet_private)
        .expect("derive responder ratchet public");
    let bob_reply = crate::e2e::encrypt_ratchet_message(crate::e2e::RatchetEncryptInput {
        session: &bob_receive.session,
        plaintext: b"bob-1",
        sender_did: "did:agent:bob",
        receiver_did: "did:agent:alice",
        message_id: Some("msg-bob-1".to_string()),
        nonce: Some(vec![2u8; 24]),
        ratchet_keypair: Some(crate::e2e::X25519KeyPair {
            private_key: responder_ratchet_private
                .clone()
                .try_into()
                .expect("responder ratchet private length"),
            public_key: responder_ratchet_public,
        }),
        now: Some(140),
    })
    .expect("encrypt bob ratchet reply");
    let alice_receive = crate::e2e::decrypt_ratchet_message(crate::e2e::RatchetDecryptInput {
        session: &alice_send.session,
        message: &bob_reply.message,
        now: Some(150),
    })
    .expect("decrypt bob ratchet reply");

    assert_eq!(alice_receive.plaintext, b"bob-1");
    assert_eq!(alice_receive.message_key, bob_reply.message_key);
    assert_eq!(
        alice_receive.session.remote_ratchet_public_key,
        bytes_to_hex(&bob_reply.message.ratchet_public_key)
    );
    assert_eq!(alice_receive.session.next_receive_message_number, 1);
}

#[test]
fn recovers_out_of_order_messages_from_skipped_keys() {
    let alice_signing = crate::identity::KeyPair::generate();
    let bob_signing = crate::identity::KeyPair::generate();
    let alice_e2e = crate::e2e::create_initial_local_e2e_config(&alice_signing)
        .expect("alice local e2e config builds");
    let bob_e2e = crate::e2e::create_initial_local_e2e_config(&bob_signing)
        .expect("bob local e2e config builds");
    let bob_device = crate::e2e::build_published_device_directory(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob device");
    let bob_bundle = crate::e2e::build_published_pre_key_bundles(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob bundle");
    let bootstrap =
        crate::e2e::build_initiator_pre_key_message(crate::e2e::BuildInitiatorPreKeyMessageInput {
            e2e: &alice_e2e,
            sender_did: "did:agent:alice",
            receiver_did: "did:agent:bob",
            recipient_device: &bob_device,
            claimed_bundle: &crate::e2e::build_claimed_pre_key_bundle(
                &bob_bundle,
                bob_bundle.one_time_pre_keys.first().cloned(),
            ),
            plaintext: b"bootstrap",
            session_id: Some("session-skipped".to_string()),
            message_id: Some("msg-bootstrap-skipped".to_string()),
            nonce: None,
            ephemeral_keypair: None,
            now: Some(200),
        })
        .expect("build bootstrap message");
    let bootstrap_receive = crate::e2e::consume_responder_pre_key_message(
        crate::e2e::ConsumeResponderPreKeyMessageInput {
            e2e: &bob_e2e,
            receiver_did: "did:agent:bob",
            message: &bootstrap.message,
            now: Some(210),
        },
    )
    .expect("consume bootstrap message");

    let alice_msg1 = crate::e2e::encrypt_ratchet_message(crate::e2e::RatchetEncryptInput {
        session: &bootstrap.session,
        plaintext: b"alice-1",
        sender_did: "did:agent:alice",
        receiver_did: "did:agent:bob",
        message_id: Some("msg-alice-1".to_string()),
        nonce: Some(vec![3u8; 24]),
        ratchet_keypair: None,
        now: Some(220),
    })
    .expect("encrypt first alice ratchet message");
    let alice_msg2 = crate::e2e::encrypt_ratchet_message(crate::e2e::RatchetEncryptInput {
        session: &alice_msg1.session,
        plaintext: b"alice-2",
        sender_did: "did:agent:alice",
        receiver_did: "did:agent:bob",
        message_id: Some("msg-alice-2".to_string()),
        nonce: Some(vec![4u8; 24]),
        ratchet_keypair: None,
        now: Some(230),
    })
    .expect("encrypt second alice ratchet message");

    let bob_receive_second = crate::e2e::decrypt_ratchet_message(crate::e2e::RatchetDecryptInput {
        session: &bootstrap_receive.session,
        message: &alice_msg2.message,
        now: Some(240),
    })
    .expect("decrypt second alice ratchet message");
    assert_eq!(bob_receive_second.plaintext, b"alice-2");
    assert_eq!(bob_receive_second.session.skipped_message_keys.len(), 1);

    let bob_receive_first = crate::e2e::decrypt_ratchet_message(crate::e2e::RatchetDecryptInput {
        session: &bob_receive_second.session,
        message: &alice_msg1.message,
        now: Some(250),
    })
    .expect("decrypt first alice ratchet message from skipped key");
    assert_eq!(bob_receive_first.plaintext, b"alice-1");
    assert!(bob_receive_first.used_skipped_message_key);
    assert!(bob_receive_first.session.skipped_message_keys.is_empty());
}

#[test]
fn encrypts_and_decrypts_application_envelope_across_prekey_and_session_messages() {
    let alice_signing = crate::identity::KeyPair::generate();
    let bob_signing = crate::identity::KeyPair::generate();
    let alice_did = crate::identity::derive_did(alice_signing.verifying_key.as_bytes());
    let bob_did = crate::identity::derive_did(bob_signing.verifying_key.as_bytes());
    let mut alice_e2e = crate::e2e::create_initial_local_e2e_config(&alice_signing)
        .expect("alice local e2e config builds");
    let mut bob_e2e = crate::e2e::create_initial_local_e2e_config(&bob_signing)
        .expect("bob local e2e config builds");
    let bob_device = crate::e2e::build_published_device_directory(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob device");
    let bob_bundle = crate::e2e::build_published_pre_key_bundles(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob bundle");
    let claimed_bundle = crate::e2e::build_claimed_pre_key_bundle(
        &bob_bundle,
        bob_bundle.one_time_pre_keys.first().cloned(),
    );

    let first_application_envelope = crate::protocol::EnvelopeUnsigned {
        id: "msg-app-prekey".to_string(),
        from: alice_did.clone(),
        to: bob_did.clone(),
        msg_type: "message".to_string(),
        protocol: "/agent/msg/1.0.0".to_string(),
        payload: serde_json::json!({"text": "hello bob"}),
        timestamp: 100,
        reply_to: None,
        thread_id: Some("thread-prekey".to_string()),
        group_id: None,
    }
    .sign(&alice_signing);
    let first_encrypted =
        crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
            e2e: &alice_e2e,
            application_envelope: &first_application_envelope,
            recipient_device: &bob_device,
            claimed_bundle: Some(&claimed_bundle),
        })
        .expect("encrypt first application envelope");
    alice_e2e = first_encrypted.e2e.clone();
    let first_transport_envelope = crate::e2e::build_encrypted_transport_envelope(
        &first_application_envelope,
        first_encrypted.payload,
        &alice_signing,
    );
    let first_decrypted =
        crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
            e2e: &bob_e2e,
            receiver_did: &bob_did,
            transport_envelope: &first_transport_envelope,
            now: Some(1000),
        })
        .expect("decrypt first application envelope");
    bob_e2e = first_decrypted.e2e.clone();

    assert_eq!(first_decrypted.transport, "prekey");
    assert_eq!(
        serde_json::to_value(&first_decrypted.application_envelope)
            .expect("serialize decrypted first application envelope"),
        serde_json::to_value(&first_application_envelope)
            .expect("serialize first application envelope"),
    );

    let stored_alice_session = crate::e2e::load_local_session(
        &alice_e2e,
        &alice_e2e.current_device_id,
        &bob_did,
        &bob_device.device_id,
    )
    .expect("load alice session")
    .expect("alice session exists");
    let stored_bob_session = crate::e2e::load_local_session(
        &bob_e2e,
        &bob_e2e.current_device_id,
        &alice_did,
        &first_decrypted.sender_device_id,
    )
    .expect("load bob session")
    .expect("bob session exists");
    assert_eq!(stored_alice_session.session_id, first_decrypted.session_id);
    assert_eq!(stored_bob_session.session_id, first_decrypted.session_id);

    let second_application_envelope = crate::protocol::EnvelopeUnsigned {
        id: "msg-app-session".to_string(),
        from: alice_did.clone(),
        to: bob_did.clone(),
        msg_type: "message".to_string(),
        protocol: "/agent/msg/1.0.0".to_string(),
        payload: serde_json::json!({"text": "hello again"}),
        timestamp: 200,
        reply_to: None,
        thread_id: Some("thread-session".to_string()),
        group_id: None,
    }
    .sign(&alice_signing);
    let second_encrypted =
        crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
            e2e: &alice_e2e,
            application_envelope: &second_application_envelope,
            recipient_device: &bob_device,
            claimed_bundle: None,
        })
        .expect("encrypt second application envelope");
    let second_transport_envelope = crate::e2e::build_encrypted_transport_envelope(
        &second_application_envelope,
        second_encrypted.payload,
        &alice_signing,
    );
    let second_decrypted =
        crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
            e2e: &bob_e2e,
            receiver_did: &bob_did,
            transport_envelope: &second_transport_envelope,
            now: Some(2000),
        })
        .expect("decrypt second application envelope");

    assert_eq!(second_decrypted.transport, "session");
    assert_eq!(
        serde_json::to_value(&second_decrypted.application_envelope)
            .expect("serialize decrypted second application envelope"),
        serde_json::to_value(&second_application_envelope)
            .expect("serialize second application envelope"),
    );
    assert!(!second_decrypted.used_skipped_message_key);
}

struct ApplicationEnvelopeFixture {
    alice_signing: crate::identity::KeyPair,
    alice_did: String,
    bob_did: String,
    alice_e2e: crate::e2e::LocalE2EConfig,
    bob_e2e: crate::e2e::LocalE2EConfig,
    bob_device: crate::e2e::PublishedDeviceDirectoryEntry,
    claimed_bundle: crate::e2e::ClaimedPreKeyBundle,
}

fn application_envelope_fixture() -> ApplicationEnvelopeFixture {
    let alice_signing = crate::identity::KeyPair::generate();
    let bob_signing = crate::identity::KeyPair::generate();
    let alice_did = crate::identity::derive_did(alice_signing.verifying_key.as_bytes());
    let bob_did = crate::identity::derive_did(bob_signing.verifying_key.as_bytes());
    let alice_e2e = crate::e2e::create_initial_local_e2e_config(&alice_signing)
        .expect("alice local e2e config builds");
    let bob_e2e = crate::e2e::create_initial_local_e2e_config(&bob_signing)
        .expect("bob local e2e config builds");
    let bob_device = crate::e2e::build_published_device_directory(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob device");
    let bob_bundle = crate::e2e::build_published_pre_key_bundles(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob bundle");
    let claimed_bundle = crate::e2e::build_claimed_pre_key_bundle(
        &bob_bundle,
        bob_bundle.one_time_pre_keys.first().cloned(),
    );

    ApplicationEnvelopeFixture {
        alice_signing,
        alice_did,
        bob_did,
        alice_e2e,
        bob_e2e,
        bob_device,
        claimed_bundle,
    }
}

fn signed_application_envelope(
    signing: &crate::identity::KeyPair,
    from: &str,
    to: &str,
    id: &str,
    text: &str,
    timestamp: u64,
) -> crate::protocol::Envelope {
    crate::protocol::EnvelopeUnsigned {
        id: id.to_string(),
        from: from.to_string(),
        to: to.to_string(),
        msg_type: "message".to_string(),
        protocol: "/agent/msg/1.0.0".to_string(),
        payload: serde_json::json!({"text": text}),
        timestamp,
        reply_to: None,
        thread_id: None,
        group_id: None,
    }
    .sign(signing)
}

#[test]
fn rejects_prekey_message_with_sender_device_identity_key_mismatch_against_published_card() {
    let fixture = application_envelope_fixture();
    let alice_device = crate::e2e::build_published_device_directory(&fixture.alice_e2e)
        .into_iter()
        .next()
        .expect("published alice device");
    let application_envelope = signed_application_envelope(
        &fixture.alice_signing,
        &fixture.alice_did,
        &fixture.bob_did,
        "msg-app-sender-device-mismatch",
        "hello bob",
        100,
    );
    let encrypted = crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
        e2e: &fixture.alice_e2e,
        application_envelope: &application_envelope,
        recipient_device: &fixture.bob_device,
        claimed_bundle: Some(&fixture.claimed_bundle),
    })
    .expect("encrypt application envelope");
    let decoded_message = crate::e2e::decode_encrypted_application_envelope_payload(&encrypted.payload)
        .expect("decode encrypted payload");
    let prekey_message = match decoded_message {
        crate::e2e::DecodedEncryptedApplicationMessage::PreKey(message) => message,
        crate::e2e::DecodedEncryptedApplicationMessage::Session(_) => panic!("expected PREKEY_MESSAGE"),
    };

    let sender_card = crate::protocol::AgentCard {
        did: fixture.alice_did.clone(),
        name: "Alice".to_string(),
        description: "Sender".to_string(),
        version: "1.0.0".to_string(),
        capabilities: vec![],
        endpoints: vec![],
        devices: Some(vec![crate::e2e::PublishedDeviceDirectoryEntry {
            identity_key_public: "00".repeat(32),
            ..alice_device
        }]),
        peer_id: None,
        trust: None,
        metadata: None,
        timestamp: 100,
        signature: "sig".to_string(),
    };

    let err = crate::e2e::assert_published_sender_device_matches_prekey_message(
        &sender_card,
        &prekey_message,
    )
    .err()
    .expect("sender device identity mismatch should fail");
    assert!(err
        .to_string()
        .contains("published identity key does not match PREKEY_MESSAGE"));
}

#[test]
fn rejects_tampered_encrypted_transport_envelope_signature() {
    let fixture = application_envelope_fixture();
    let application_envelope = signed_application_envelope(
        &fixture.alice_signing,
        &fixture.alice_did,
        &fixture.bob_did,
        "msg-app-tampered",
        "hello bob",
        100,
    );
    let encrypted = crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
        e2e: &fixture.alice_e2e,
        application_envelope: &application_envelope,
        recipient_device: &fixture.bob_device,
        claimed_bundle: Some(&fixture.claimed_bundle),
    })
    .expect("encrypt application envelope");
    let mut transport_envelope = crate::e2e::build_encrypted_transport_envelope(
        &application_envelope,
        encrypted.payload,
        &fixture.alice_signing,
    );
    transport_envelope.signature = "00".repeat(64);

    let err = crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
        e2e: &fixture.bob_e2e,
        receiver_did: &fixture.bob_did,
        transport_envelope: &transport_envelope,
        now: Some(1000),
    })
    .err().expect("tampered transport signature should fail");
    assert!(err
        .to_string()
        .contains("Encrypted transport envelope signature verification failed"));
}

#[test]
fn rejects_impersonated_decrypted_application_envelope_signature() {
    let fixture = application_envelope_fixture();
    let mallory_signing = crate::identity::KeyPair::generate();
    let impersonated_application_envelope = signed_application_envelope(
        &mallory_signing,
        &fixture.alice_did,
        &fixture.bob_did,
        "msg-app-impersonated",
        "mallory says hi",
        100,
    );
    let encrypted = crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
        e2e: &fixture.alice_e2e,
        application_envelope: &impersonated_application_envelope,
        recipient_device: &fixture.bob_device,
        claimed_bundle: Some(&fixture.claimed_bundle),
    })
    .expect("encrypt application envelope");
    let transport_envelope = crate::e2e::build_encrypted_transport_envelope(
        &impersonated_application_envelope,
        encrypted.payload,
        &fixture.alice_signing,
    );

    let err = crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
        e2e: &fixture.bob_e2e,
        receiver_did: &fixture.bob_did,
        transport_envelope: &transport_envelope,
        now: Some(1000),
    })
    .err().expect("impersonated inner signature should fail");
    assert!(err
        .to_string()
        .contains("Decrypted application envelope signature verification failed"));
}

#[test]
fn rejects_double_consumption_of_the_same_one_time_pre_key() {
    let fixture = application_envelope_fixture();
    let application_envelope = signed_application_envelope(
        &fixture.alice_signing,
        &fixture.alice_did,
        &fixture.bob_did,
        "msg-app-double-otk",
        "hello once",
        100,
    );
    let encrypted = crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
        e2e: &fixture.alice_e2e,
        application_envelope: &application_envelope,
        recipient_device: &fixture.bob_device,
        claimed_bundle: Some(&fixture.claimed_bundle),
    })
    .expect("encrypt application envelope");
    let transport_envelope = crate::e2e::build_encrypted_transport_envelope(
        &application_envelope,
        encrypted.payload,
        &fixture.alice_signing,
    );
    let first = crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
        e2e: &fixture.bob_e2e,
        receiver_did: &fixture.bob_did,
        transport_envelope: &transport_envelope,
        now: Some(1000),
    })
    .expect("first decrypt succeeds");

    let err = crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
        e2e: &first.e2e,
        receiver_did: &fixture.bob_did,
        transport_envelope: &transport_envelope,
        now: Some(2000),
    })
    .err().expect("reusing claimed OTK should fail");
    assert!(err
        .to_string()
        .contains("Claimed one-time pre-key already consumed for PREKEY_MESSAGE"));
}


#[test]
fn rejects_session_message_with_tampered_ciphertext_before_application_delivery() {
    let fixture = application_envelope_fixture();
    let mut alice_e2e = fixture.alice_e2e.clone();
    let mut bob_e2e = fixture.bob_e2e.clone();

    let first_application_envelope = signed_application_envelope(
        &fixture.alice_signing,
        &fixture.alice_did,
        &fixture.bob_did,
        "msg-app-tampered-ciphertext-prekey",
        "hello bob",
        100,
    );
    let first_encrypted = crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
        e2e: &alice_e2e,
        application_envelope: &first_application_envelope,
        recipient_device: &fixture.bob_device,
        claimed_bundle: Some(&fixture.claimed_bundle),
    })
    .expect("encrypt first application envelope");
    alice_e2e = first_encrypted.e2e.clone();
    let first_transport_envelope = crate::e2e::build_encrypted_transport_envelope(
        &first_application_envelope,
        first_encrypted.payload,
        &fixture.alice_signing,
    );
    let first_decrypted = crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
        e2e: &bob_e2e,
        receiver_did: &fixture.bob_did,
        transport_envelope: &first_transport_envelope,
        now: Some(1000),
    })
    .expect("decrypt first application envelope");
    bob_e2e = first_decrypted.e2e.clone();

    let second_application_envelope = signed_application_envelope(
        &fixture.alice_signing,
        &fixture.alice_did,
        &fixture.bob_did,
        "msg-app-tampered-ciphertext-session",
        "hello again",
        200,
    );
    let second_encrypted = crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
        e2e: &alice_e2e,
        application_envelope: &second_application_envelope,
        recipient_device: &fixture.bob_device,
        claimed_bundle: None,
    })
    .expect("encrypt second application envelope");
    let mut payload = second_encrypted.payload.clone();
    let mut session_message = match crate::e2e::decode_encrypted_application_envelope_payload(&payload)
        .expect("decode encrypted payload")
    {
        crate::e2e::DecodedEncryptedApplicationMessage::Session(message) => message,
        crate::e2e::DecodedEncryptedApplicationMessage::PreKey(_) => panic!("expected SESSION_MESSAGE"),
    };
    let last = session_message.ciphertext.len() - 1;
    session_message.ciphertext[last] ^= 0x01;
    payload.wire_message = bytes_to_hex(&encode_session_message(&session_message).expect("encode tampered session message"));
    let tampered_transport_envelope = crate::e2e::build_encrypted_transport_envelope(
        &second_application_envelope,
        payload,
        &fixture.alice_signing,
    );

    let err = crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
        e2e: &bob_e2e,
        receiver_did: &fixture.bob_did,
        transport_envelope: &tampered_transport_envelope,
        now: Some(2000),
    })
    .err().expect("tampered ciphertext should fail");
    assert!(err
        .to_string()
        .contains("Failed to decrypt with XChaCha20-Poly1305"));
}

#[test]
fn rejects_session_message_with_tampered_ratchet_header_before_application_delivery() {
    let fixture = application_envelope_fixture();
    let mut alice_e2e = fixture.alice_e2e.clone();
    let mut bob_e2e = fixture.bob_e2e.clone();

    let first_application_envelope = signed_application_envelope(
        &fixture.alice_signing,
        &fixture.alice_did,
        &fixture.bob_did,
        "msg-app-tampered-header-prekey",
        "hello bob",
        100,
    );
    let first_encrypted = crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
        e2e: &alice_e2e,
        application_envelope: &first_application_envelope,
        recipient_device: &fixture.bob_device,
        claimed_bundle: Some(&fixture.claimed_bundle),
    })
    .expect("encrypt first application envelope");
    alice_e2e = first_encrypted.e2e.clone();
    let first_transport_envelope = crate::e2e::build_encrypted_transport_envelope(
        &first_application_envelope,
        first_encrypted.payload,
        &fixture.alice_signing,
    );
    let first_decrypted = crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
        e2e: &bob_e2e,
        receiver_did: &fixture.bob_did,
        transport_envelope: &first_transport_envelope,
        now: Some(1000),
    })
    .expect("decrypt first application envelope");
    bob_e2e = first_decrypted.e2e.clone();

    let second_application_envelope = signed_application_envelope(
        &fixture.alice_signing,
        &fixture.alice_did,
        &fixture.bob_did,
        "msg-app-tampered-header-session",
        "hello again",
        200,
    );
    let second_encrypted = crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
        e2e: &alice_e2e,
        application_envelope: &second_application_envelope,
        recipient_device: &fixture.bob_device,
        claimed_bundle: None,
    })
    .expect("encrypt second application envelope");
    let mut payload = second_encrypted.payload.clone();
    let mut session_message = match crate::e2e::decode_encrypted_application_envelope_payload(&payload)
        .expect("decode encrypted payload")
    {
        crate::e2e::DecodedEncryptedApplicationMessage::Session(message) => message,
        crate::e2e::DecodedEncryptedApplicationMessage::PreKey(_) => panic!("expected SESSION_MESSAGE"),
    };
    session_message.message_number += 1;
    payload.wire_message = bytes_to_hex(&encode_session_message(&session_message).expect("encode tampered session message"));
    let tampered_transport_envelope = crate::e2e::build_encrypted_transport_envelope(
        &second_application_envelope,
        payload,
        &fixture.alice_signing,
    );

    let err = crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
        e2e: &bob_e2e,
        receiver_did: &fixture.bob_did,
        transport_envelope: &tampered_transport_envelope,
        now: Some(2000),
    })
    .err().expect("tampered ratchet header should fail");
    assert!(err
        .to_string()
        .contains("Failed to decrypt with XChaCha20-Poly1305"));
}

#[test]
fn rejects_replayed_session_message_after_ratchet_state_advances() {
    let fixture = application_envelope_fixture();
    let mut alice_e2e = fixture.alice_e2e.clone();
    let mut bob_e2e = fixture.bob_e2e.clone();

    let first_application_envelope = signed_application_envelope(
        &fixture.alice_signing,
        &fixture.alice_did,
        &fixture.bob_did,
        "msg-app-prekey-replay",
        "hello bob",
        100,
    );
    let first_encrypted = crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
        e2e: &alice_e2e,
        application_envelope: &first_application_envelope,
        recipient_device: &fixture.bob_device,
        claimed_bundle: Some(&fixture.claimed_bundle),
    })
    .expect("encrypt first application envelope");
    alice_e2e = first_encrypted.e2e.clone();
    let first_transport_envelope = crate::e2e::build_encrypted_transport_envelope(
        &first_application_envelope,
        first_encrypted.payload,
        &fixture.alice_signing,
    );
    let first_decrypted = crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
        e2e: &bob_e2e,
        receiver_did: &fixture.bob_did,
        transport_envelope: &first_transport_envelope,
        now: Some(1000),
    })
    .expect("decrypt first application envelope");
    bob_e2e = first_decrypted.e2e.clone();

    let second_application_envelope = signed_application_envelope(
        &fixture.alice_signing,
        &fixture.alice_did,
        &fixture.bob_did,
        "msg-app-session-replay",
        "hello again",
        200,
    );
    let second_encrypted = crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
        e2e: &alice_e2e,
        application_envelope: &second_application_envelope,
        recipient_device: &fixture.bob_device,
        claimed_bundle: None,
    })
    .expect("encrypt second application envelope");
    let second_transport_envelope = crate::e2e::build_encrypted_transport_envelope(
        &second_application_envelope,
        second_encrypted.payload,
        &fixture.alice_signing,
    );
    let second_decrypted = crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
        e2e: &bob_e2e,
        receiver_did: &fixture.bob_did,
        transport_envelope: &second_transport_envelope,
        now: Some(2000),
    })
    .expect("decrypt second application envelope");

    let err = crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
        e2e: &second_decrypted.e2e,
        receiver_did: &fixture.bob_did,
        transport_envelope: &second_transport_envelope,
        now: Some(3000),
    })
    .err().expect("replayed session message should fail");
    assert!(err
        .to_string()
        .contains("Failed to decrypt with XChaCha20-Poly1305"));
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct CrossLangArtifactMessage {
    #[serde(rename = "expectedTransport")]
    expected_transport: String,
    #[serde(rename = "transportEnvelope")]
    transport_envelope: crate::protocol::Envelope,
    #[serde(rename = "applicationEnvelope")]
    application_envelope: crate::protocol::Envelope,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct CrossLangArtifact {
    version: u32,
    #[serde(rename = "caseId")]
    case_id: String,
    #[serde(rename = "initiatorImpl")]
    initiator_impl: String,
    #[serde(rename = "responderImpl")]
    responder_impl: String,
    #[serde(rename = "receiverDid")]
    receiver_did: String,
    #[serde(rename = "receiverE2EConfig")]
    receiver_e2e_config: crate::e2e::LocalE2EConfig,
    messages: Vec<CrossLangArtifactMessage>,
}

fn read_cross_lang_artifact_from_env(var: &str) -> Option<(std::path::PathBuf, CrossLangArtifact)> {
    let path = std::env::var_os(var).map(std::path::PathBuf::from)?;
    let artifact = serde_json::from_slice::<CrossLangArtifact>(
        &std::fs::read(&path).expect("read cross-language artifact"),
    )
    .expect("parse cross-language artifact");
    Some((path, artifact))
}

#[test]
fn cross_lang_consumes_js_artifact() {
    let Some((_path, artifact)) = read_cross_lang_artifact_from_env("QUADRA_A_CROSS_LANG_INPUT")
    else {
        eprintln!("Skipping cross_lang_consumes_js_artifact: QUADRA_A_CROSS_LANG_INPUT not set");
        return;
    };

    assert_eq!(artifact.case_id, "E2E-CROSS-001");
    assert_eq!(artifact.initiator_impl, "js");
    assert_eq!(artifact.responder_impl, "rust");
    assert_eq!(artifact.messages.len(), 2);

    let mut e2e = artifact.receiver_e2e_config.clone();
    for message in artifact.messages {
        let decrypted =
            crate::e2e::decrypt_application_envelope(crate::e2e::DecryptApplicationEnvelopeInput {
                e2e: &e2e,
                receiver_did: &artifact.receiver_did,
                transport_envelope: &message.transport_envelope,
                now: None,
            })
            .expect("decrypt JS artifact envelope in Rust");

        assert_eq!(decrypted.transport, message.expected_transport);
        assert_eq!(
            serde_json::to_value(&decrypted.application_envelope)
                .expect("serialize decrypted application envelope"),
            serde_json::to_value(&message.application_envelope)
                .expect("serialize expected application envelope"),
        );
        e2e = decrypted.e2e;
    }
}

#[test]
fn cross_lang_emits_rust_artifact() {
    let Some(path) = std::env::var_os("QUADRA_A_CROSS_LANG_OUTPUT").map(std::path::PathBuf::from)
    else {
        eprintln!("Skipping cross_lang_emits_rust_artifact: QUADRA_A_CROSS_LANG_OUTPUT not set");
        return;
    };

    let alice_signing = crate::identity::KeyPair::generate();
    let bob_signing = crate::identity::KeyPair::generate();
    let alice_did = crate::identity::derive_did(alice_signing.verifying_key.as_bytes());
    let bob_did = crate::identity::derive_did(bob_signing.verifying_key.as_bytes());
    let mut alice_e2e = crate::e2e::create_initial_local_e2e_config(&alice_signing)
        .expect("alice local e2e config builds");
    let bob_e2e = crate::e2e::create_initial_local_e2e_config(&bob_signing)
        .expect("bob local e2e config builds");
    let bob_device = crate::e2e::build_published_device_directory(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob device");
    let bob_bundle = crate::e2e::build_published_pre_key_bundles(&bob_e2e)
        .into_iter()
        .next()
        .expect("published bob bundle");
    let claimed_bundle = crate::e2e::build_claimed_pre_key_bundle(
        &bob_bundle,
        bob_bundle.one_time_pre_keys.first().cloned(),
    );

    let first_application_envelope = crate::protocol::EnvelopeUnsigned {
        id: "cross-rust-to-js-1".to_string(),
        from: alice_did.clone(),
        to: bob_did.clone(),
        msg_type: "message".to_string(),
        protocol: "/agent/msg/1.0.0".to_string(),
        payload: serde_json::json!({"text": "hello from rust"}),
        timestamp: 100,
        reply_to: None,
        thread_id: Some("cross-rust-to-js-1".to_string()),
        group_id: None,
    }
    .sign(&alice_signing);
    let first_encrypted =
        crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
            e2e: &alice_e2e,
            application_envelope: &first_application_envelope,
            recipient_device: &bob_device,
            claimed_bundle: Some(&claimed_bundle),
        })
        .expect("encrypt first Rust artifact envelope");
    alice_e2e = first_encrypted.e2e.clone();
    let first_transport_envelope = crate::e2e::build_encrypted_transport_envelope(
        &first_application_envelope,
        first_encrypted.payload,
        &alice_signing,
    );

    let second_application_envelope = crate::protocol::EnvelopeUnsigned {
        id: "cross-rust-to-js-2".to_string(),
        from: alice_did,
        to: bob_did.clone(),
        msg_type: "message".to_string(),
        protocol: "/agent/msg/1.0.0".to_string(),
        payload: serde_json::json!({"text": "hello again from rust"}),
        timestamp: 200,
        reply_to: None,
        thread_id: Some("cross-rust-to-js-2".to_string()),
        group_id: None,
    }
    .sign(&alice_signing);
    let second_encrypted =
        crate::e2e::encrypt_application_envelope(crate::e2e::EncryptApplicationEnvelopeInput {
            e2e: &alice_e2e,
            application_envelope: &second_application_envelope,
            recipient_device: &bob_device,
            claimed_bundle: None,
        })
        .expect("encrypt second Rust artifact envelope");
    let second_transport_envelope = crate::e2e::build_encrypted_transport_envelope(
        &second_application_envelope,
        second_encrypted.payload,
        &alice_signing,
    );

    let artifact = CrossLangArtifact {
        version: 1,
        case_id: "E2E-CROSS-002".to_string(),
        initiator_impl: "rust".to_string(),
        responder_impl: "js".to_string(),
        receiver_did: bob_did,
        receiver_e2e_config: bob_e2e,
        messages: vec![
            CrossLangArtifactMessage {
                expected_transport: "prekey".to_string(),
                transport_envelope: first_transport_envelope,
                application_envelope: first_application_envelope,
            },
            CrossLangArtifactMessage {
                expected_transport: "session".to_string(),
                transport_envelope: second_transport_envelope,
                application_envelope: second_application_envelope,
            },
        ],
    };

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create cross-language artifact directory");
    }
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&artifact).expect("serialize Rust artifact"),
    )
    .expect("write Rust cross-language artifact");
}
