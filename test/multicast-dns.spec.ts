/* eslint-env mocha */

import { expect } from 'aegir/chai'
import type { Multiaddr } from '@multiformats/multiaddr'
import { multiaddr } from '@multiformats/multiaddr'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import pWaitFor from 'p-wait-for'
import { mdns } from './../src/index.js'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { PeerInfo } from '@libp2p/interface-peer-info'
import { stubInterface } from 'ts-sinon'
import type { AddressManager } from '@libp2p/interface-address-manager'
import { start, stop } from '@libp2p/interfaces/startable'

function getComponents (peerId: PeerId, multiaddrs: Multiaddr[]) {
  const addressManager = stubInterface<AddressManager>()
  addressManager.getAddresses.returns(multiaddrs)

  return { peerId, addressManager }
}

describe('MulticastDNS', () => {
  let pA: PeerId
  let aMultiaddrs: Multiaddr[]
  let pB: PeerId
  let bMultiaddrs: Multiaddr[]
  let pC: PeerId
  let cMultiaddrs: Multiaddr[]
  let pD: PeerId
  let dMultiaddrs: Multiaddr[]

  before(async function () {
    this.timeout(80 * 1000)

    ;[pA, pB, pC, pD] = await Promise.all([
      createEd25519PeerId(),
      createEd25519PeerId(),
      createEd25519PeerId(),
      createEd25519PeerId()
    ])

    aMultiaddrs = [
      multiaddr('/ip4/127.0.0.1/tcp/20001'),
      multiaddr('/dns4/webrtc-star.discovery.libp2p.io/tcp/443/wss/p2p-webrtc-star'),
      multiaddr('/dns4/discovery.libp2p.io/tcp/8443')
    ]

    bMultiaddrs = [
      multiaddr('/ip4/127.0.0.1/tcp/20002'),
      multiaddr('/ip6/::1/tcp/20002'),
      multiaddr('/dnsaddr/discovery.libp2p.io')
    ]

    cMultiaddrs = [
      multiaddr('/ip4/127.0.0.1/tcp/20003'),
      multiaddr('/ip4/127.0.0.1/tcp/30003/ws'),
      multiaddr('/dns4/discovery.libp2p.io')
    ]

    dMultiaddrs = [
      multiaddr('/ip4/127.0.0.1/tcp/30003/ws')
    ]
  })

  it('find another peer', async function () {
    this.timeout(40 * 1000)

    const mdnsA = mdns({
      broadcast: false, // do not talk to ourself
      port: 50001,
      compat: false
    })(getComponents(pA, aMultiaddrs))

    const mdnsB = mdns({
      port: 50001, // port must be the same
      compat: false
    })(getComponents(pB, bMultiaddrs))

    await start(mdnsA, mdnsB)

    const { detail: { id } } = await new Promise<CustomEvent<PeerInfo>>((resolve) => mdnsA.addEventListener('peer', resolve, {
      once: true
    }))

    expect(pB.toString()).to.eql(id.toString())

    await stop(mdnsA, mdnsB)
  })

  it('only announce TCP multiaddrs', async function () {
    this.timeout(40 * 1000)

    const mdnsA = mdns({
      broadcast: false, // do not talk to ourself
      port: 50003,
      compat: false
    })(getComponents(pA, aMultiaddrs))
    const mdnsC = mdns({
      port: 50003, // port must be the same
      compat: false
    })(getComponents(pC, cMultiaddrs))
    const mdnsD = mdns({
      port: 50003, // port must be the same
      compat: false
    })(getComponents(pD, dMultiaddrs))

    await start(mdnsA, mdnsC, mdnsD)

    const peers = new Map()
    const expectedPeer = pC.toString()

    const foundPeer = (evt: CustomEvent<PeerInfo>) => peers.set(evt.detail.id.toString(), evt.detail)
    mdnsA.addEventListener('peer', foundPeer)

    await pWaitFor(() => peers.has(expectedPeer))
    mdnsA.removeEventListener('peer', foundPeer)

    expect(peers.get(expectedPeer).multiaddrs.length).to.equal(1)

    await stop(mdnsA, mdnsC, mdnsD)
  })

  it('announces IP6 addresses', async function () {
    this.timeout(40 * 1000)

    const mdnsA = mdns({
      broadcast: false, // do not talk to ourself
      port: 50001,
      compat: false
    })(getComponents(pA, aMultiaddrs))

    const mdnsB = mdns({
      port: 50001,
      compat: false
    })(getComponents(pB, bMultiaddrs))

    await start(mdnsA, mdnsB)

    const { detail: { id, multiaddrs } } = await new Promise<CustomEvent<PeerInfo>>((resolve) => mdnsA.addEventListener('peer', resolve, {
      once: true
    }))

    expect(pB.toString()).to.eql(id.toString())
    expect(multiaddrs.length).to.equal(2)

    await stop(mdnsA, mdnsB)
  })

  it('doesn\'t emit peers after stop', async function () {
    this.timeout(40 * 1000)

    const mdnsA = mdns({
      port: 50004, // port must be the same
      compat: false
    })(getComponents(pA, aMultiaddrs))

    const mdnsC = mdns({
      port: 50004,
      compat: false
    })(getComponents(pD, dMultiaddrs))

    await start(mdnsA)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await stop(mdnsA)
    await start(mdnsC)

    mdnsC.addEventListener('peer', () => {
      throw new Error('Should not receive new peer.')
    }, {
      once: true
    })

    await new Promise((resolve) => setTimeout(resolve, 5000))
    await stop(mdnsC)
  })

  it('should start and stop with go-libp2p-mdns compat', async () => {
    const mdnsA = mdns({
      port: 50004
    })(getComponents(pA, aMultiaddrs))

    await start(mdnsA)
    await stop(mdnsA)
  })

  it('should not emit undefined peer ids', async () => {
    const mdnsA = mdns({
      port: 50004
    })(getComponents(pA, aMultiaddrs))
    await start(mdnsA)

    await new Promise<void>((resolve, reject) => {
      mdnsA.addEventListener('peer', (evt) => {
        if (evt.detail == null) {
          reject(new Error('peerData was not set'))
        }
      })

      // @ts-expect-error not a PeerDiscovery field
      if (mdnsA.mdns == null) {
        reject(new Error('mdns property was not set'))
        return
      }

      // @ts-expect-error not a PeerDiscovery field
      mdnsA.mdns.on('response', () => {
        // query.gotResponse is async - we'll bail from that method when
        // comparing the senders PeerId to our own but it'll happen later
        // so allow enough time for the test to have failed if we emit
        // empty peerData objects
        setTimeout(() => {
          resolve()
        }, 100)
      })

      // this will cause us to respond to ourselves
      // @ts-expect-error not a PeerDiscovery field
      mdnsA.mdns.query({
        questions: [{
          name: 'localhost',
          type: 'A'
        }]
      })
    })

    await stop(mdnsA)
  })

  it('find another peer with different udp4 address', async function () {
    this.timeout(40 * 1000)

    const mdnsA = mdns({
      broadcast: false, // do not talk to ourself
      port: 50005,
      ip: '224.0.0.252',
      compat: false
    })(getComponents(pA, aMultiaddrs))

    const mdnsB = mdns({
      port: 50005, // port must be the same
      ip: '224.0.0.252', // ip must be the same
      compat: false
    })(getComponents(pB, bMultiaddrs))

    await start(mdnsA, mdnsB)

    const { detail: { id } } = await new Promise<CustomEvent<PeerInfo>>((resolve) => mdnsA.addEventListener('peer', resolve, {
      once: true
    }))

    expect(pB.toString()).to.eql(id.toString())

    await stop(mdnsA, mdnsB)
  })
})
