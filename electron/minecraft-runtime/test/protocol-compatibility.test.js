/* global require, Buffer */
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const minecraftData = require('minecraft-data');
const minecraftProtocol = require('minecraft-protocol');
const { withMinecraftProtocolCompatibility, correctedEntityMetadataProtocol } = require('../protocolCompatibility');

function metadataPacket(variant, baby = false) {
  const mapping = minecraftData('1.21.8').protocol.play.toClient.types.packet[1]
    .find((field) => field.name === 'name').type[1].mappings;
  const packetId = Number(Object.entries(mapping).find(([, name]) => name === 'entity_metadata')[0]);
  const health = Buffer.alloc(4);
  health.writeFloatBE(4);
  // Real vanilla 1.21.8 uses the registry's raw VarInt, including zero, with
  // no inline-holder/string branch. Health and baby share the same packet.
  return Buffer.concat([Buffer.from([packetId, 17, 9, 3]), health,
    Buffer.from([16, 8, Number(baby), 17, 28, variant, 255])]);
}

function compatibleClient(version) {
  const options = withMinecraftProtocolCompatibility({ version });
  const Client = options.Client || minecraftProtocol.Client;
  return new Client(false, version || minecraftProtocol.defaultVersion, undefined, true);
}

function expectMetadata(client, variant, baby) {
  const parsed = client.deserializer.parsePacketBuffer(metadataPacket(variant, baby));
  assert.equal(parsed.data.name, 'entity_metadata');
  assert.equal(parsed.data.params.entityId, 17);
  assert.deepEqual(parsed.data.params.metadata, [
    { key: 9, type: 'float', value: 4 },
    { key: 16, type: 'boolean', value: baby },
    { key: 17, type: 'chicken_variant', value: variant },
  ]);
}

test('version-scoped client decodes chicken zero variant and preserves same-packet health and age', () => {
  const data = minecraftData('1.21.8');
  const original = JSON.stringify(data.protocol);
  // Deliberately prime the upstream bad cache before creating our client.
  const stock = minecraftProtocol.createDeserializer({ state: 'play', version: '1.21.8', noErrorLogging: true });
  assert.throws(() => stock.parsePacketBuffer(metadataPacket(0, true)), /Unexpected buffer end while reading VarInt/);
  const client = compatibleClient('1.21.8');
  client.state = 'play';
  expectMetadata(client, 0, true);
  expectMetadata(client, 1, false);
  expectMetadata(client, 2, true);
  assert.equal(JSON.stringify(data.protocol), original, 'The installed shared schema stays immutable');
  assert.notEqual(client.deserializer.proto, stock.proto, 'An already compiled bad global cache is not reused');
  assert.throws(() => stock.parsePacketBuffer(metadataPacket(0, true)), /Unexpected buffer end while reading VarInt/);
});

test('auto-detected full version receives the fix before PLAY, without patching another 1.21 protocol', () => {
  const client = compatibleClient(false);
  const original = JSON.stringify(minecraftData('1.21.8').protocol);
  // Installed autoVersion resolves client.version, then rebuilds handshaking
  // serializers before login/configuration and PLAY. No network is used here.
  client.version = '1.21.8';
  client.state = 'handshaking';
  client.state = 'play';
  expectMetadata(client, 0, false);
  assert.equal(JSON.stringify(minecraftData('1.21.8').protocol), original);
  for (const version of ['1.21.5', '1.21.9']) {
    const other = minecraftProtocol.createDeserializer({ state: 'play', version, noErrorLogging: true });
    client.version = version;
    client.state = 'play';
    assert.equal(client.deserializer.proto, other.proto, 'The resolved version, not its shared 1.21 major, controls replacement');
  }
});

test('the existing official FullPacketParser stream emits complete metadata through the client listener', async () => {
  const client = compatibleClient('1.21.8');
  client.state = 'play';
  const received = [];
  client.on('entity_metadata', (packet) => received.push(packet));
  await new Promise((resolve, reject) => client.deserializer.write(metadataPacket(0, true),
    (error) => error ? reject(error) : resolve()));
  assert.equal(received.length, 1);
  assert.equal(received[0].metadata.find((entry) => entry.key === 9).value, 4);
  assert.equal(received[0].metadata.find((entry) => entry.key === 16).value, true);
  assert.equal(received[0].metadata.find((entry) => entry.key === 17).value, 0);
});

test('explicit non-target versions keep their original options and schemas', () => {
  for (const version of ['1.16.5', '1.21.5', '1.21.6', '1.21.7', '1.21.9', '1.21.11']) {
    const options = { version, username: 'DeskPet' };
    const protocol = minecraftData(version).protocol;
    const before = JSON.stringify(protocol);
    assert.equal(withMinecraftProtocolCompatibility(options), options);
    assert.equal(correctedEntityMetadataProtocol(version, protocol), null);
    assert.equal(JSON.stringify(protocol), before);
  }
});

test('future corrected schema is left alone and correction does not mutate its input', () => {
  const original = minecraftData('1.21.8').protocol;
  const before = JSON.stringify(original);
  const corrected = correctedEntityMetadataProtocol('1.21.8', original);
  assert.ok(corrected);
  assert.notEqual(corrected, original);
  assert.equal(JSON.stringify(original), before);
  assert.equal(correctedEntityMetadataProtocol('1.21.8', corrected), null);
});

test('runtime exports the same options helper used by the real-server harness', () => {
  assert.equal(require('../runtime').withMinecraftProtocolCompatibility, withMinecraftProtocolCompatibility);
});
