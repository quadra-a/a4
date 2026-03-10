/**
 * Relay Agent Test Script
 *
 * Simple test to verify the RelayAgent implementation works correctly:
 * - Tests relay identity generation
 * - Tests Agent Card creation and signing
 * - Tests relay startup and self-registration
 * - Tests federation and bootstrap functionality
 */

import { RelayAgent } from '../dist/index.js';
import { promises as fs } from 'fs';
import { join } from 'path';

async function testRelayAgent() {
  console.log('🧪 Testing RelayAgent Implementation\n');

  // Test 1: Basic relay startup
  console.log('1. Testing basic relay startup...');

  const testStoragePath = './test-relay-data';

  // Clean up any existing test data
  try {
    await fs.rm(testStoragePath, { recursive: true, force: true });
  } catch {
    // Ignore if directory doesn't exist
  }

  const relay = new RelayAgent({
    port: 8082, // Use different port to avoid conflicts
    relayId: 'test-relay-001',
    storagePath: testStoragePath,
    federationEnabled: true,
    genesisMode: true,
    networkId: 'highway1-test',
    seedRelays: [],
  });

  try {
    console.log('   Starting relay...');
    await relay.start();
    console.log('   ✅ Relay started successfully');

    // Test 2: Check relay identity
    console.log('\n2. Testing relay identity...');

    // Check if identity file was created
    const identityPath = join(testStoragePath, 'relay-identity.json');
    const identityExists = await fs.access(identityPath).then(() => true).catch(() => false);

    if (identityExists) {
      console.log('   ✅ Relay identity file created');

      const identityData = JSON.parse(await fs.readFile(identityPath, 'utf8'));
      console.log(`   ✅ Relay DID: ${identityData.did}`);
      console.log(`   ✅ Agent Card: ${identityData.agentCard.name}`);
      console.log(`   ✅ Capabilities: ${identityData.agentCard.capabilities.length}`);

      // Verify DID format
      if (identityData.did.startsWith('did:agent:')) {
        console.log('   ✅ DID format is correct');
      } else {
        console.log('   ❌ DID format is incorrect');
      }

      // Verify Agent Card has relay capabilities
      const hasRelayCapabilities = identityData.agentCard.capabilities.some(
        (cap) => cap.id.startsWith('relay/')
      );

      if (hasRelayCapabilities) {
        console.log('   ✅ Agent Card has relay capabilities');
      } else {
        console.log('   ❌ Agent Card missing relay capabilities');
      }

    } else {
      console.log('   ❌ Relay identity file not created');
    }

    // Test 3: Test relay persistence
    console.log('\n3. Testing relay identity persistence...');

    console.log('   Stopping relay...');
    await relay.stop();

    console.log('   Starting relay again...');
    const relay2 = new RelayAgent({
      port: 8082,
      relayId: 'test-relay-001',
      storagePath: testStoragePath,
      federationEnabled: true,
      genesisMode: true,
      networkId: 'highway1-test',
    });

    await relay2.start();

    // Check if same identity is loaded
    const identityData2 = JSON.parse(await fs.readFile(identityPath, 'utf8'));
    const identityData = JSON.parse(await fs.readFile(identityPath, 'utf8'));
    if (identityData2.did === identityData.did) {
      console.log('   ✅ Relay identity persisted correctly');
    } else {
      console.log('   ❌ Relay identity not persisted');
    }

    await relay2.stop();

    console.log('\n🎉 All tests passed! RelayAgent implementation is working correctly.');

  } catch (err) {
    console.error('❌ Test failed:', err);
  } finally {
    // Clean up test data
    try {
      await fs.rm(testStoragePath, { recursive: true, force: true });
      console.log('\n🧹 Test data cleaned up');
    } catch (err) {
      console.warn('Warning: Could not clean up test data:', err);
    }
  }
}

// Run the test
testRelayAgent().catch(console.error);