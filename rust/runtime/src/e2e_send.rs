use anyhow::{anyhow, Result};

use quadra_a_core::config::Config;
use quadra_a_core::e2e::{
    build_encrypted_transport_envelope, encrypt_application_envelope, load_local_session,
    verify_signed_pre_key_record, ClaimedPreKeyBundle, EncryptApplicationEnvelopeInput,
    PublishedDeviceDirectoryEntry, SignedPreKeyRecord,
};
use quadra_a_core::identity::{extract_public_key, KeyPair};
use quadra_a_core::protocol::{cbor_x_encode_json, AgentCard, Envelope};

use crate::relay::RelaySession;

pub struct PreparedEncryptedSendTarget {
    pub outer_envelope: Envelope,
    pub outer_envelope_bytes: Vec<u8>,
    pub transport: String,
    pub sender_device_id: String,
    pub recipient_device_id: String,
    pub session_id: String,
}

pub struct PreparedEncryptedSendBatch {
    pub application_envelope: Envelope,
    pub config: Config,
    pub targets: Vec<PreparedEncryptedSendTarget>,
}

pub struct PreparedEncryptedSend {
    pub application_envelope: Envelope,
    pub outer_envelope: Envelope,
    pub outer_envelope_bytes: Vec<u8>,
    pub config: Config,
    pub transport: String,
    pub recipient_device_id: String,
}

pub fn select_recipient_devices(card: &AgentCard) -> Result<Vec<PublishedDeviceDirectoryEntry>> {
    let mut devices = card.devices.as_ref().cloned().unwrap_or_default();
    match devices.len() {
        0 => anyhow::bail!("Target {} does not publish any E2E devices", card.did),
        _ => {
            devices.sort_by(|left, right| left.device_id.cmp(&right.device_id));
            for pair in devices.windows(2) {
                if pair[0].device_id == pair[1].device_id {
                    anyhow::bail!(
                        "Target {} publishes duplicate E2E device {}",
                        card.did,
                        pair[0].device_id
                    );
                }
            }
            Ok(devices)
        }
    }
}

pub fn select_single_recipient_device(card: &AgentCard) -> Result<PublishedDeviceDirectoryEntry> {
    let devices = select_recipient_devices(card)?;
    match devices.len() {
        1 => Ok(devices.into_iter().next().expect("single device exists")),
        count => anyhow::bail!(
            "Target {} publishes {} E2E devices; use multi-device fan-out instead of prepare_encrypted_send_with_session",
            card.did,
            count
        ),
    }
}

fn assert_recipient_signed_pre_key_bundle(
    did: &str,
    claimed_bundle: &ClaimedPreKeyBundle,
) -> Result<()> {
    let verifying_key = extract_public_key(did)?;
    let record = SignedPreKeyRecord {
        device_id: claimed_bundle.device_id.clone(),
        signed_pre_key_id: claimed_bundle.signed_pre_key_id,
        signed_pre_key_public: hex::decode(&claimed_bundle.signed_pre_key_public)
            .map_err(|_| anyhow!("Failed to decode recipient signed pre-key public hex"))?,
        signature: hex::decode(&claimed_bundle.signed_pre_key_signature)
            .map_err(|_| anyhow!("Failed to decode recipient signed pre-key signature hex"))?,
    };

    if !verify_signed_pre_key_record(&record, &verifying_key)? {
        anyhow::bail!(
            "Target {}:{} publishes invalid signed pre-key signature",
            did,
            claimed_bundle.device_id
        );
    }

    Ok(())
}

pub async fn prepare_encrypted_sends_with_session(
    session: &mut RelaySession,
    config: &Config,
    keypair: &KeyPair,
    application_envelope: Envelope,
) -> Result<PreparedEncryptedSendBatch> {
    let card = session
        .fetch_card(&application_envelope.to)
        .await?
        .ok_or_else(|| anyhow!("No Agent Card found for {}", application_envelope.to))?;
    let recipient_devices = select_recipient_devices(&card)?;
    let mut next_config = config.clone();
    let mut targets = Vec::with_capacity(recipient_devices.len());

    for recipient_device in recipient_devices {
        let e2e = next_config
            .e2e
            .as_ref()
            .ok_or_else(|| anyhow!("Missing local E2E config"))?;
        let existing_session = load_local_session(
            e2e,
            &e2e.current_device_id,
            &application_envelope.to,
            &recipient_device.device_id,
        )?;
        let claimed_bundle = if existing_session.is_some() {
            None
        } else {
            Some(
                session
                    .fetch_prekey_bundle(&application_envelope.to, &recipient_device.device_id)
                    .await?
                    .ok_or_else(|| {
                        anyhow!(
                            "No claimed pre-key bundle available for {}:{}",
                            application_envelope.to,
                            recipient_device.device_id
                        )
                    })?,
            )
        };

        if let Some(claimed_bundle) = claimed_bundle.as_ref() {
            assert_recipient_signed_pre_key_bundle(&application_envelope.to, claimed_bundle)?;
        }

        let encrypted = encrypt_application_envelope(EncryptApplicationEnvelopeInput {
            e2e,
            application_envelope: &application_envelope,
            recipient_device: &recipient_device,
            claimed_bundle: claimed_bundle.as_ref(),
        })?;
        let sender_device_id = encrypted.payload.sender_device_id.clone();
        let session_id = encrypted.payload.session_id.clone();
        let outer_envelope =
            build_encrypted_transport_envelope(&application_envelope, encrypted.payload, keypair);
        let outer_envelope_bytes = cbor_x_encode_json(&serde_json::to_value(&outer_envelope)?);
        next_config.e2e = Some(encrypted.e2e);

        targets.push(PreparedEncryptedSendTarget {
            outer_envelope,
            outer_envelope_bytes,
            transport: encrypted.transport.to_string(),
            sender_device_id,
            recipient_device_id: recipient_device.device_id,
            session_id,
        });
    }

    Ok(PreparedEncryptedSendBatch {
        application_envelope,
        config: next_config,
        targets,
    })
}

pub async fn prepare_encrypted_send_with_session(
    session: &mut RelaySession,
    config: &Config,
    keypair: &KeyPair,
    application_envelope: Envelope,
) -> Result<PreparedEncryptedSend> {
    let prepared =
        prepare_encrypted_sends_with_session(session, config, keypair, application_envelope)
            .await?;
    let target_count = prepared.targets.len();
    if target_count != 1 {
        anyhow::bail!(
            "Encrypted send prepared {} recipient targets; use prepare_encrypted_sends_with_session for multi-device fan-out",
            target_count
        );
    }
    let target = prepared
        .targets
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("Encrypted send prepared no recipient targets"))?;

    Ok(PreparedEncryptedSend {
        application_envelope: prepared.application_envelope,
        outer_envelope: target.outer_envelope,
        outer_envelope_bytes: target.outer_envelope_bytes,
        config: prepared.config,
        transport: target.transport,
        recipient_device_id: target.recipient_device_id,
    })
}

#[cfg(test)]
mod tests {
    use super::{prepare_encrypted_send_with_session, prepare_encrypted_sends_with_session};
    use crate::card::build_agent_card_from_config;
    use crate::e2e_receive::prepare_encrypted_receive;
    use crate::relay::RelaySession;
    use anyhow::Result;
    use futures_util::{SinkExt, StreamExt};
    use quadra_a_core::config::{AgentCardConfig, Config, IdentityConfig};
    use quadra_a_core::e2e::{
        build_claimed_pre_key_bundle, build_published_device_directory,
        build_published_pre_key_bundles, create_local_device_state,
        decode_encrypted_application_envelope_payload, ensure_local_e2e_config,
        rotate_local_device_signed_pre_key, DecodedEncryptedApplicationMessage, E2EMessageType,
        EncryptedApplicationEnvelopePayload, E2E_APPLICATION_ENVELOPE_PROTOCOL,
    };
    use quadra_a_core::identity::{derive_did, KeyPair};
    use quadra_a_core::protocol::{cbor_decode_value, EnvelopeUnsigned};
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    #[derive(Default)]
    struct FakeRelayScenario {
        fetched_cards: HashMap<String, Value>,
        fetch_prekey_bundles: HashMap<String, Vec<Value>>,
    }

    async fn spawn_fake_relay(
        scenario: FakeRelayScenario,
    ) -> Result<(String, tokio::task::JoinHandle<Result<()>>)> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;

        let handle = tokio::spawn(async move {
            let mut scenario = scenario;
            let (stream, _) = listener.accept().await?;
            let mut socket = accept_async(stream).await?;

            while let Some(message) = socket.next().await {
                let message = message?;
                let payload = match message {
                    Message::Binary(bytes) => cbor_decode_value(&bytes)?,
                    Message::Text(text) => serde_json::from_str::<Value>(&text)?,
                    Message::Ping(_) | Message::Pong(_) => continue,
                    Message::Close(_) => break,
                    other => anyhow::bail!("Unsupported test relay message: {:?}", other),
                };

                match payload.get("type").and_then(|value| value.as_str()) {
                    Some("HELLO") => {
                        socket
                            .send(Message::Text(
                                json!({
                                    "type": "WELCOME",
                                    "protocolVersion": 1,
                                    "relayId": "relay:test",
                                    "peers": 1,
                                    "federatedRelays": [],
                                    "yourAddr": "127.0.0.1"
                                })
                                .to_string(),
                            ))
                            .await?;
                    }
                    Some("FETCH_CARD") => {
                        let did = payload
                            .get("did")
                            .and_then(|value| value.as_str())
                            .unwrap_or_default();
                        let card = scenario
                            .fetched_cards
                            .get(did)
                            .cloned()
                            .unwrap_or(Value::Null);
                        socket
                            .send(Message::Text(
                                json!({
                                    "type": "CARD",
                                    "did": did,
                                    "card": card
                                })
                                .to_string(),
                            ))
                            .await?;
                    }
                    Some("FETCH_PREKEY_BUNDLE") => {
                        let did = payload
                            .get("did")
                            .and_then(|value| value.as_str())
                            .unwrap_or_default();
                        let device_id = payload
                            .get("deviceId")
                            .and_then(|value| value.as_str())
                            .unwrap_or_default();
                        let key = format!("{}:{}", did, device_id);
                        let bundle = scenario
                            .fetch_prekey_bundles
                            .get_mut(&key)
                            .and_then(|responses| {
                                if responses.is_empty() {
                                    None
                                } else {
                                    Some(responses.remove(0))
                                }
                            })
                            .unwrap_or(Value::Null);
                        socket
                            .send(Message::Text(
                                json!({
                                    "type": "PREKEY_BUNDLE",
                                    "did": did,
                                    "deviceId": device_id,
                                    "bundle": bundle
                                })
                                .to_string(),
                            ))
                            .await?;
                    }
                    Some("GOODBYE") => break,
                    Some("PING") => {
                        socket
                            .send(Message::Text(
                                json!({ "type": "PONG", "peers": 1 }).to_string(),
                            ))
                            .await?;
                    }
                    _ => {}
                }
            }

            Ok(())
        });

        Ok((format!("ws://{}", address), handle))
    }

    fn build_config(name: &str) -> Config {
        let keypair = KeyPair::generate();
        let did = derive_did(keypair.verifying_key.as_bytes());
        let mut config = Config {
            identity: Some(IdentityConfig {
                did,
                public_key: keypair.public_key_hex(),
                private_key: keypair.private_key_hex(),
            }),
            agent_card: Some(AgentCardConfig {
                name: name.to_string(),
                description: format!("{} description", name),
                capabilities: vec!["chat".to_string()],
            }),
            ..Config::default()
        };
        ensure_local_e2e_config(&mut config).expect("e2e config created");
        config
    }

    #[tokio::test]
    async fn prepare_encrypted_send_fetches_prekey_once_then_reuses_session() {
        let alice_config = build_config("Alice");
        let bob_config = build_config("Bob");
        let alice_identity = alice_config
            .identity
            .as_ref()
            .expect("alice identity")
            .clone();
        let alice_keypair = KeyPair::from_hex(&alice_identity.private_key).expect("alice keypair");
        let alice_card = build_agent_card_from_config(&alice_config, &alice_identity)
            .expect("alice card builds");

        let bob_identity = bob_config.identity.as_ref().expect("bob identity").clone();
        let bob_card =
            build_agent_card_from_config(&bob_config, &bob_identity).expect("bob card builds");
        let bob_device =
            build_published_device_directory(bob_config.e2e.as_ref().expect("bob e2e"))
                .into_iter()
                .next()
                .expect("published bob device");
        let bob_bundle = build_published_pre_key_bundles(bob_config.e2e.as_ref().expect("bob e2e"))
            .into_iter()
            .next()
            .expect("published bob bundle");
        let claimed_bundle = build_claimed_pre_key_bundle(
            &bob_bundle,
            bob_bundle.one_time_pre_keys.first().cloned(),
        );

        let (relay_url, relay_task) = spawn_fake_relay(FakeRelayScenario {
            fetched_cards: HashMap::from([(
                bob_identity.did.clone(),
                serde_json::to_value(&bob_card).expect("serialize bob card"),
            )]),
            fetch_prekey_bundles: HashMap::from([(
                format!("{}:{}", bob_identity.did, bob_device.device_id),
                vec![serde_json::to_value(&claimed_bundle).expect("serialize claimed bundle")],
            )]),
        })
        .await
        .expect("spawn fake relay");

        let mut session =
            RelaySession::connect(&relay_url, &alice_identity.did, &alice_card, &alice_keypair)
                .await
                .expect("connect relay session");

        let first_envelope = EnvelopeUnsigned {
            id: "msg-runtime-1".to_string(),
            from: alice_identity.did.clone(),
            to: bob_identity.did.clone(),
            msg_type: "message".to_string(),
            protocol: "/agent/msg/1.0.0".to_string(),
            payload: json!({"text": "hello bob"}),
            timestamp: 100,
            reply_to: None,
            thread_id: Some("thread-one".to_string()),
            group_id: None,
        }
        .sign(&alice_keypair);
        let first = prepare_encrypted_send_with_session(
            &mut session,
            &alice_config,
            &alice_keypair,
            first_envelope,
        )
        .await
        .expect("prepare first encrypted send");

        assert_eq!(
            first.outer_envelope.protocol,
            E2E_APPLICATION_ENVELOPE_PROTOCOL
        );
        assert_eq!(first.outer_envelope.id, first.application_envelope.id);
        assert!(first.outer_envelope.thread_id.is_none());
        let first_payload: EncryptedApplicationEnvelopePayload =
            serde_json::from_value(first.outer_envelope.payload.clone())
                .expect("deserialize first outer payload");
        assert_eq!(first_payload.message_type, E2EMessageType::PreKeyMessage);
        match decode_encrypted_application_envelope_payload(&first_payload)
            .expect("decode first encrypted payload")
        {
            DecodedEncryptedApplicationMessage::PreKey(message) => {
                assert_eq!(message.receiver_device_id, bob_device.device_id);
            }
            DecodedEncryptedApplicationMessage::Session(_) => panic!("expected PREKEY_MESSAGE"),
        }

        let second_envelope = EnvelopeUnsigned {
            id: "msg-runtime-2".to_string(),
            from: alice_identity.did.clone(),
            to: bob_identity.did.clone(),
            msg_type: "message".to_string(),
            protocol: "/agent/msg/1.0.0".to_string(),
            payload: json!({"text": "hello again"}),
            timestamp: 200,
            reply_to: None,
            thread_id: Some("thread-two".to_string()),
            group_id: None,
        }
        .sign(&alice_keypair);
        let second = prepare_encrypted_send_with_session(
            &mut session,
            &first.config,
            &alice_keypair,
            second_envelope,
        )
        .await
        .expect("prepare second encrypted send");

        let second_payload: EncryptedApplicationEnvelopePayload =
            serde_json::from_value(second.outer_envelope.payload.clone())
                .expect("deserialize second outer payload");
        assert_eq!(second_payload.message_type, E2EMessageType::SessionMessage);
        match decode_encrypted_application_envelope_payload(&second_payload)
            .expect("decode second encrypted payload")
        {
            DecodedEncryptedApplicationMessage::Session(message) => {
                assert_eq!(message.receiver_device_id, bob_device.device_id);
            }
            DecodedEncryptedApplicationMessage::PreKey(_) => panic!("expected SESSION_MESSAGE"),
        }

        session.goodbye().await.expect("close relay session");
        relay_task
            .await
            .expect("join fake relay")
            .expect("relay result");
    }

    #[tokio::test]
    async fn prepare_encrypted_sends_fan_out_to_all_recipient_devices_and_reuse_sessions() {
        let alice_config = build_config("Alice");
        let mut bob_config = build_config("Bob");
        let alice_identity = alice_config
            .identity
            .as_ref()
            .expect("alice identity")
            .clone();
        let alice_keypair = KeyPair::from_hex(&alice_identity.private_key).expect("alice keypair");
        let alice_card = build_agent_card_from_config(&alice_config, &alice_identity)
            .expect("alice card builds");

        let bob_identity = bob_config.identity.as_ref().expect("bob identity").clone();
        let bob_signing_keypair =
            KeyPair::from_hex(&bob_identity.private_key).expect("bob keypair");
        let second_bob_device = create_local_device_state(
            &bob_signing_keypair,
            Some("device-bob-secondary".to_string()),
            Some(2),
            16,
            2,
        )
        .expect("second bob device");
        bob_config
            .e2e
            .as_mut()
            .expect("bob e2e")
            .devices
            .insert(second_bob_device.device_id.clone(), second_bob_device);

        let bob_card =
            build_agent_card_from_config(&bob_config, &bob_identity).expect("bob card builds");
        let mut bob_devices =
            build_published_device_directory(bob_config.e2e.as_ref().expect("bob e2e"));
        bob_devices.sort_by(|left, right| left.device_id.cmp(&right.device_id));
        let bob_bundles =
            build_published_pre_key_bundles(bob_config.e2e.as_ref().expect("bob e2e"));

        let fetch_prekey_bundles = bob_bundles
            .iter()
            .map(|bundle| {
                let claimed_bundle =
                    build_claimed_pre_key_bundle(bundle, bundle.one_time_pre_keys.first().cloned());
                (
                    format!("{}:{}", bob_identity.did, bundle.device_id),
                    vec![serde_json::to_value(&claimed_bundle).expect("serialize claimed bundle")],
                )
            })
            .collect::<HashMap<_, _>>();

        let (relay_url, relay_task) = spawn_fake_relay(FakeRelayScenario {
            fetched_cards: HashMap::from([(
                bob_identity.did.clone(),
                serde_json::to_value(&bob_card).expect("serialize bob card"),
            )]),
            fetch_prekey_bundles,
        })
        .await
        .expect("spawn fake relay");

        let mut session =
            RelaySession::connect(&relay_url, &alice_identity.did, &alice_card, &alice_keypair)
                .await
                .expect("connect relay session");

        let first_envelope = EnvelopeUnsigned {
            id: "msg-runtime-multi-1".to_string(),
            from: alice_identity.did.clone(),
            to: bob_identity.did.clone(),
            msg_type: "message".to_string(),
            protocol: "/agent/msg/1.0.0".to_string(),
            payload: json!({"text": "hello all devices"}),
            timestamp: 100,
            reply_to: None,
            thread_id: Some("thread-multi-one".to_string()),
            group_id: None,
        }
        .sign(&alice_keypair);
        let first = prepare_encrypted_sends_with_session(
            &mut session,
            &alice_config,
            &alice_keypair,
            first_envelope,
        )
        .await
        .expect("prepare first multi-device send");

        assert_eq!(first.targets.len(), 2);
        let mut expected_device_ids = bob_devices
            .iter()
            .map(|device| device.device_id.clone())
            .collect::<Vec<_>>();
        expected_device_ids.sort();
        let mut actual_device_ids = first
            .targets
            .iter()
            .map(|target| target.recipient_device_id.clone())
            .collect::<Vec<_>>();
        actual_device_ids.sort();
        assert_eq!(actual_device_ids, expected_device_ids);

        for target in &first.targets {
            assert_eq!(target.outer_envelope.id, first.application_envelope.id);
            let payload: EncryptedApplicationEnvelopePayload =
                serde_json::from_value(target.outer_envelope.payload.clone())
                    .expect("deserialize first multi payload");
            assert_eq!(payload.message_type, E2EMessageType::PreKeyMessage);
            match decode_encrypted_application_envelope_payload(&payload)
                .expect("decode first multi payload")
            {
                DecodedEncryptedApplicationMessage::PreKey(message) => {
                    assert_eq!(message.receiver_device_id, target.recipient_device_id);
                }
                DecodedEncryptedApplicationMessage::Session(_) => panic!("expected PREKEY_MESSAGE"),
            }
        }

        let mut receiver_config = bob_config.clone();
        for target in &first.targets {
            let received = prepare_encrypted_receive(&receiver_config, &target.outer_envelope)
                .expect("decrypt first multi-device receive");
            assert_eq!(received.transport, "prekey");
            assert_eq!(
                serde_json::to_value(&received.application_envelope)
                    .expect("serialize first received multi envelope"),
                serde_json::to_value(&first.application_envelope)
                    .expect("serialize first sent multi envelope"),
            );
            receiver_config = received.config;
        }
        let receiver_session_count = receiver_config
            .e2e
            .as_ref()
            .expect("receiver e2e")
            .devices
            .values()
            .map(|device| device.sessions.len())
            .sum::<usize>();
        assert_eq!(receiver_session_count, 2);

        let second_envelope = EnvelopeUnsigned {
            id: "msg-runtime-multi-2".to_string(),
            from: alice_identity.did.clone(),
            to: bob_identity.did.clone(),
            msg_type: "message".to_string(),
            protocol: "/agent/msg/1.0.0".to_string(),
            payload: json!({"text": "hello again all devices"}),
            timestamp: 200,
            reply_to: None,
            thread_id: Some("thread-multi-two".to_string()),
            group_id: None,
        }
        .sign(&alice_keypair);
        let second = prepare_encrypted_sends_with_session(
            &mut session,
            &first.config,
            &alice_keypair,
            second_envelope,
        )
        .await
        .expect("prepare second multi-device send");

        assert_eq!(second.targets.len(), 2);
        for target in &second.targets {
            let payload: EncryptedApplicationEnvelopePayload =
                serde_json::from_value(target.outer_envelope.payload.clone())
                    .expect("deserialize second multi payload");
            assert_eq!(payload.message_type, E2EMessageType::SessionMessage);
            match decode_encrypted_application_envelope_payload(&payload)
                .expect("decode second multi payload")
            {
                DecodedEncryptedApplicationMessage::Session(message) => {
                    assert_eq!(message.receiver_device_id, target.recipient_device_id);
                }
                DecodedEncryptedApplicationMessage::PreKey(_) => panic!("expected SESSION_MESSAGE"),
            }
        }

        for target in &second.targets {
            let received = prepare_encrypted_receive(&receiver_config, &target.outer_envelope)
                .expect("decrypt second multi-device receive");
            assert_eq!(received.transport, "session");
            assert!(!received.used_skipped_message_key);
            receiver_config = received.config;
        }

        session.goodbye().await.expect("close relay session");
        relay_task
            .await
            .expect("join fake relay")
            .expect("relay result");
    }

    #[tokio::test]
    async fn prepare_encrypted_send_rejects_invalid_signed_pre_key_signature() {
        let alice_config = build_config("Alice");
        let mut bob_config = build_config("Bob");
        let alice_identity = alice_config
            .identity
            .as_ref()
            .expect("alice identity")
            .clone();
        let alice_keypair = KeyPair::from_hex(&alice_identity.private_key).expect("alice keypair");
        let alice_card = build_agent_card_from_config(&alice_config, &alice_identity)
            .expect("alice card builds");

        let bob_identity = bob_config.identity.as_ref().expect("bob identity").clone();
        let bob_current_device_id = bob_config
            .e2e
            .as_ref()
            .expect("bob e2e")
            .current_device_id
            .clone();
        let tampered_signature = "00".repeat(64);
        bob_config
            .e2e
            .as_mut()
            .expect("bob e2e")
            .devices
            .get_mut(&bob_current_device_id)
            .expect("bob current device")
            .signed_pre_key
            .signature = tampered_signature.clone();

        let bob_card =
            build_agent_card_from_config(&bob_config, &bob_identity).expect("bob card builds");
        let bob_device =
            build_published_device_directory(bob_config.e2e.as_ref().expect("bob e2e"))
                .into_iter()
                .next()
                .expect("published bob device");
        let bob_bundle = build_published_pre_key_bundles(bob_config.e2e.as_ref().expect("bob e2e"))
            .into_iter()
            .next()
            .expect("published bob bundle");
        let claimed_bundle = build_claimed_pre_key_bundle(
            &bob_bundle,
            bob_bundle.one_time_pre_keys.first().cloned(),
        );

        let mut scenario = FakeRelayScenario::default();
        scenario.fetched_cards.insert(
            bob_identity.did.clone(),
            serde_json::to_value(&bob_card).expect("serialize bob card"),
        );
        scenario.fetch_prekey_bundles.insert(
            format!("{}:{}", bob_identity.did, bob_device.device_id),
            vec![serde_json::to_value(&claimed_bundle).expect("serialize claimed bundle")],
        );

        let (relay_url, relay_task) = spawn_fake_relay(scenario).await.expect("spawn fake relay");
        let mut session =
            RelaySession::connect(&relay_url, &alice_identity.did, &alice_card, &alice_keypair)
                .await
                .expect("connect relay session");

        let envelope = EnvelopeUnsigned {
            id: "msg-runtime-send-invalid-signed-prekey".to_string(),
            from: alice_identity.did.clone(),
            to: bob_identity.did.clone(),
            msg_type: "message".to_string(),
            protocol: "/agent/msg/1.0.0".to_string(),
            payload: json!({"text": "hello bob"}),
            timestamp: 100,
            reply_to: None,
            thread_id: Some("thread-invalid-signed-prekey".to_string()),
            group_id: None,
        }
        .sign(&alice_keypair);

        let err = prepare_encrypted_send_with_session(
            &mut session,
            &alice_config,
            &alice_keypair,
            envelope,
        )
        .await
        .err()
        .expect("invalid signed pre-key signature should fail");
        assert!(err.to_string().contains(&format!(
            "Target {}:{} publishes invalid signed pre-key signature",
            bob_identity.did, bob_device.device_id
        )));

        session.goodbye().await.expect("close relay session");
        relay_task
            .await
            .expect("join fake relay")
            .expect("relay result");
    }

    #[tokio::test]
    async fn prepare_encrypted_receive_bootstraps_then_reuses_session() {
        let alice_config = build_config("Alice");
        let bob_config = build_config("Bob");
        let alice_identity = alice_config
            .identity
            .as_ref()
            .expect("alice identity")
            .clone();
        let alice_keypair = KeyPair::from_hex(&alice_identity.private_key).expect("alice keypair");
        let alice_card = build_agent_card_from_config(&alice_config, &alice_identity)
            .expect("alice card builds");

        let bob_identity = bob_config.identity.as_ref().expect("bob identity").clone();
        let bob_card =
            build_agent_card_from_config(&bob_config, &bob_identity).expect("bob card builds");
        let bob_device =
            build_published_device_directory(bob_config.e2e.as_ref().expect("bob e2e"))
                .into_iter()
                .next()
                .expect("published bob device");
        let bob_bundle = build_published_pre_key_bundles(bob_config.e2e.as_ref().expect("bob e2e"))
            .into_iter()
            .next()
            .expect("published bob bundle");
        let claimed_bundle = build_claimed_pre_key_bundle(
            &bob_bundle,
            bob_bundle.one_time_pre_keys.first().cloned(),
        );

        let mut scenario = FakeRelayScenario::default();
        scenario.fetched_cards.insert(
            bob_identity.did.clone(),
            serde_json::to_value(&bob_card).expect("serialize bob card"),
        );
        scenario.fetch_prekey_bundles.insert(
            format!("{}:{}", bob_identity.did, bob_device.device_id),
            vec![serde_json::to_value(&claimed_bundle).expect("serialize claimed bundle")],
        );

        let (relay_url, relay_task) = spawn_fake_relay(scenario).await.expect("spawn fake relay");
        let mut session =
            RelaySession::connect(&relay_url, &alice_identity.did, &alice_card, &alice_keypair)
                .await
                .expect("connect relay session");

        let first_envelope = EnvelopeUnsigned {
            id: "msg-runtime-recv-1".to_string(),
            from: alice_identity.did.clone(),
            to: bob_identity.did.clone(),
            msg_type: "message".to_string(),
            protocol: "/agent/msg/1.0.0".to_string(),
            payload: json!({"text": "hello bob"}),
            timestamp: 100,
            reply_to: None,
            thread_id: Some("thread-one".to_string()),
            group_id: None,
        }
        .sign(&alice_keypair);
        let first = prepare_encrypted_send_with_session(
            &mut session,
            &alice_config,
            &alice_keypair,
            first_envelope,
        )
        .await
        .expect("prepare first encrypted send");
        let first_received = prepare_encrypted_receive(&bob_config, &first.outer_envelope)
            .expect("decrypt first encrypted receive");

        assert_eq!(first_received.transport, "prekey");
        assert_eq!(
            serde_json::to_value(&first_received.application_envelope)
                .expect("serialize received first envelope"),
            serde_json::to_value(&first.application_envelope)
                .expect("serialize first application envelope"),
        );

        let second_envelope = EnvelopeUnsigned {
            id: "msg-runtime-recv-2".to_string(),
            from: alice_identity.did.clone(),
            to: bob_identity.did.clone(),
            msg_type: "message".to_string(),
            protocol: "/agent/msg/1.0.0".to_string(),
            payload: json!({"text": "hello again"}),
            timestamp: 200,
            reply_to: None,
            thread_id: Some("thread-two".to_string()),
            group_id: None,
        }
        .sign(&alice_keypair);
        let second = prepare_encrypted_send_with_session(
            &mut session,
            &first.config,
            &alice_keypair,
            second_envelope,
        )
        .await
        .expect("prepare second encrypted send");
        let second_received =
            prepare_encrypted_receive(&first_received.config, &second.outer_envelope)
                .expect("decrypt second encrypted receive");

        assert_eq!(second_received.transport, "session");
        assert_eq!(
            serde_json::to_value(&second_received.application_envelope)
                .expect("serialize received second envelope"),
            serde_json::to_value(&second.application_envelope)
                .expect("serialize second application envelope"),
        );
        assert!(!second_received.used_skipped_message_key);

        session.goodbye().await.expect("close relay session");
        relay_task
            .await
            .expect("join fake relay")
            .expect("relay result");
    }

    #[tokio::test]
    async fn prepare_encrypted_receive_rejects_replayed_prekey_message_after_initial_consumption() {
        let alice_config = build_config("Alice");
        let bob_config = build_config("Bob");
        let alice_identity = alice_config
            .identity
            .as_ref()
            .expect("alice identity")
            .clone();
        let alice_keypair = KeyPair::from_hex(&alice_identity.private_key).expect("alice keypair");
        let alice_card = build_agent_card_from_config(&alice_config, &alice_identity)
            .expect("alice card builds");

        let bob_identity = bob_config.identity.as_ref().expect("bob identity").clone();
        let bob_card =
            build_agent_card_from_config(&bob_config, &bob_identity).expect("bob card builds");
        let bob_device =
            build_published_device_directory(bob_config.e2e.as_ref().expect("bob e2e"))
                .into_iter()
                .next()
                .expect("published bob device");
        let bob_bundle = build_published_pre_key_bundles(bob_config.e2e.as_ref().expect("bob e2e"))
            .into_iter()
            .next()
            .expect("published bob bundle");
        let claimed_bundle = build_claimed_pre_key_bundle(
            &bob_bundle,
            bob_bundle.one_time_pre_keys.first().cloned(),
        );

        let mut scenario = FakeRelayScenario::default();
        scenario.fetched_cards.insert(
            bob_identity.did.clone(),
            serde_json::to_value(&bob_card).expect("serialize bob card"),
        );
        scenario.fetch_prekey_bundles.insert(
            format!("{}:{}", bob_identity.did, bob_device.device_id),
            vec![serde_json::to_value(&claimed_bundle).expect("serialize claimed bundle")],
        );

        let (relay_url, relay_task) = spawn_fake_relay(scenario).await.expect("spawn fake relay");
        let mut session =
            RelaySession::connect(&relay_url, &alice_identity.did, &alice_card, &alice_keypair)
                .await
                .expect("connect relay session");

        let first_envelope = EnvelopeUnsigned {
            id: "msg-runtime-recv-replay-1".to_string(),
            from: alice_identity.did.clone(),
            to: bob_identity.did.clone(),
            msg_type: "message".to_string(),
            protocol: "/agent/msg/1.0.0".to_string(),
            payload: json!({"text": "hello bob"}),
            timestamp: 100,
            reply_to: None,
            thread_id: Some("thread-prekey-replay".to_string()),
            group_id: None,
        }
        .sign(&alice_keypair);
        let first = prepare_encrypted_send_with_session(
            &mut session,
            &alice_config,
            &alice_keypair,
            first_envelope,
        )
        .await
        .expect("prepare first encrypted send");
        let first_received = prepare_encrypted_receive(&bob_config, &first.outer_envelope)
            .expect("decrypt first encrypted receive");

        let replay_error = prepare_encrypted_receive(&first_received.config, &first.outer_envelope)
            .err()
            .expect("replayed prekey message should fail");
        assert!(replay_error
            .to_string()
            .contains("Claimed one-time pre-key already consumed for PREKEY_MESSAGE"));

        session.goodbye().await.expect("close relay session");
        relay_task
            .await
            .expect("join fake relay")
            .expect("relay result");
    }

    #[tokio::test]
    async fn prepare_encrypted_receive_rejects_prekey_message_for_rotated_out_signed_pre_key() {
        let alice_config = build_config("Alice");
        let bob_config = build_config("Bob");
        let alice_identity = alice_config
            .identity
            .as_ref()
            .expect("alice identity")
            .clone();
        let alice_keypair = KeyPair::from_hex(&alice_identity.private_key).expect("alice keypair");
        let alice_card = build_agent_card_from_config(&alice_config, &alice_identity)
            .expect("alice card builds");

        let bob_identity = bob_config.identity.as_ref().expect("bob identity").clone();
        let bob_card =
            build_agent_card_from_config(&bob_config, &bob_identity).expect("bob card builds");
        let bob_device =
            build_published_device_directory(bob_config.e2e.as_ref().expect("bob e2e"))
                .into_iter()
                .next()
                .expect("published bob device");
        let bob_bundle = build_published_pre_key_bundles(bob_config.e2e.as_ref().expect("bob e2e"))
            .into_iter()
            .next()
            .expect("published bob bundle");
        let claimed_bundle = build_claimed_pre_key_bundle(
            &bob_bundle,
            bob_bundle.one_time_pre_keys.first().cloned(),
        );

        let mut scenario = FakeRelayScenario::default();
        scenario.fetched_cards.insert(
            bob_identity.did.clone(),
            serde_json::to_value(&bob_card).expect("serialize bob card"),
        );
        scenario.fetch_prekey_bundles.insert(
            format!("{}:{}", bob_identity.did, bob_device.device_id),
            vec![serde_json::to_value(&claimed_bundle).expect("serialize claimed bundle")],
        );

        let (relay_url, relay_task) = spawn_fake_relay(scenario).await.expect("spawn fake relay");
        let mut session =
            RelaySession::connect(&relay_url, &alice_identity.did, &alice_card, &alice_keypair)
                .await
                .expect("connect relay session");

        let first_envelope = EnvelopeUnsigned {
            id: "msg-runtime-recv-rotated-signed-prekey-1".to_string(),
            from: alice_identity.did.clone(),
            to: bob_identity.did.clone(),
            msg_type: "message".to_string(),
            protocol: "/agent/msg/1.0.0".to_string(),
            payload: json!({"text": "hello bob"}),
            timestamp: 100,
            reply_to: None,
            thread_id: Some("thread-rotated-signed-prekey".to_string()),
            group_id: None,
        }
        .sign(&alice_keypair);
        let first = prepare_encrypted_send_with_session(
            &mut session,
            &alice_config,
            &alice_keypair,
            first_envelope,
        )
        .await
        .expect("prepare first encrypted send");

        let bob_signing_keypair =
            KeyPair::from_hex(&bob_identity.private_key).expect("bob keypair");
        let bob_current_device_id = bob_config
            .e2e
            .as_ref()
            .expect("bob e2e")
            .current_device_id
            .clone();
        let rotated_bob_e2e = rotate_local_device_signed_pre_key(
            &bob_signing_keypair,
            bob_config.e2e.as_ref().expect("bob e2e"),
            &bob_current_device_id,
            None,
            None,
            Some(200),
        )
        .expect("rotate bob signed pre-key");
        let mut rotated_bob_config = bob_config.clone();
        rotated_bob_config.e2e = Some(rotated_bob_e2e);

        let error = prepare_encrypted_receive(&rotated_bob_config, &first.outer_envelope)
            .err()
            .expect("rotated-out signed pre-key should fail");
        assert!(error.to_string().contains(
            "PREKEY_MESSAGE signed pre-key id does not match current receiver device state"
        ));

        session.goodbye().await.expect("close relay session");
        relay_task
            .await
            .expect("join fake relay")
            .expect("relay result");
    }

    #[tokio::test]
    async fn prepare_encrypted_receive_rejects_legacy_plaintext_application_envelope() {
        let alice_config = build_config("Alice");
        let bob_config = build_config("Bob");
        let alice_identity = alice_config
            .identity
            .as_ref()
            .expect("alice identity")
            .clone();
        let alice_keypair = KeyPair::from_hex(&alice_identity.private_key).expect("alice keypair");
        let bob_identity = bob_config.identity.as_ref().expect("bob identity").clone();

        let legacy_envelope = EnvelopeUnsigned {
            id: "msg-runtime-recv-legacy-1".to_string(),
            from: alice_identity.did.clone(),
            to: bob_identity.did.clone(),
            msg_type: "message".to_string(),
            protocol: "/agent/msg/1.0.0".to_string(),
            payload: json!({"text": "legacy plaintext should be rejected"}),
            timestamp: 100,
            reply_to: None,
            thread_id: Some("thread-legacy-plaintext".to_string()),
            group_id: None,
        }
        .sign(&alice_keypair);

        let error = prepare_encrypted_receive(&bob_config, &legacy_envelope)
            .err()
            .expect("legacy plaintext should fail");
        assert!(error
            .to_string()
            .contains("Transport envelope protocol mismatch"));
        assert!(error
            .to_string()
            .contains(E2E_APPLICATION_ENVELOPE_PROTOCOL));
    }
}
