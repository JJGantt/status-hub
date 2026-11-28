#if os(iOS)
import CoreBluetooth
import Foundation
import WatchConnectivity

/// AN EXPERIMENT, observation only (docs/DOOR.md § Arrival): can the phone tell when the Apple Watch
/// reconnects to it over Bluetooth? If it can, that is how he arriving home with only the watch, while
/// the phone waits at home, is seen. Nothing here unlocks anything; it logs what iOS actually reports,
/// as `watch-link` lines in `client_log` and in the elevator pane's live log, so the answer is measured.
///
/// Three sources, each logged as it fires:
/// - CoreBluetooth CONNECTION EVENTS (`registerForConnectionEvents`): iOS reports a matching peripheral
///   connecting or disconnecting at the system level, even one this app never connected to. Matched by
///   the services below and by any peripheral `retrieveConnectedPeripherals` turned up. Needs
///   `bluetooth-central` in UIBackgroundModes to arrive in the background; a restore identifier lets iOS
///   relaunch the app for them.
/// - A SNAPSHOT of `retrieveConnectedPeripherals(withServices:)` at launch and whenever watching near
///   home starts: which system-connected peripherals carry those services.
/// - WatchConnectivity (`WatchLink`'s delegate calls `observe`): pairing, install and reachability.
///   Reachability means the watch APP can take a message, not the radio link, which is why it is only
///   one of three.
@MainActor
final class WatchLinkWatch: NSObject, CBCentralManagerDelegate {
    static let shared = WatchLinkWatch()

    /// Device Information, Battery, Apple's Continuity service and Apple's Nearby service.
    private static let services = ["180A", "180F", "D0611E78-BBB4-4591-A5F8-487910AE4366",
                                   "9FA480E0-4967-4542-9390-D343DC5D04AE"].map { CBUUID(string: $0) }

    private var central: CBCentralManager?
    /// Peripherals seen connected to the system, by identifier: their names, and matched for events.
    private var known: [UUID: String] = [:]
    /// The last connection event logged for each peripheral, so a repeat of the same state is not logged.
    private var lastState: [UUID: String] = [:]

    /// At launch, and each time watching near home starts. The first call creates the manager, which is
    /// also when iOS asks for Bluetooth permission.
    func start() {
        if let central, central.state == .poweredOn { snapshot(central, why: "watching") }
        else if central == nil {
            central = CBCentralManager(delegate: self, queue: .main,
                                       options: [CBCentralManagerOptionRestoreIdentifierKey: "watch-link"])
        }
    }

    private func snapshot(_ c: CBCentralManager, why: String) {
        let found = c.retrieveConnectedPeripherals(withServices: Self.services)
        for p in found { known[p.identifier] = p.name ?? "?" }
        log("connected now", ["why": why, "count": found.count,
                              "peripherals": found.map { "\($0.name ?? "?") \($0.identifier.uuidString.prefix(8))" }])
        register(c)
    }

    /// Matches by service and by every peripheral seen so far; a new call replaces the last.
    private func register(_ c: CBCentralManager) {
        var opts: [CBConnectionEventMatchingOption: Any] = [.serviceUUIDs: Self.services]
        if !known.isEmpty { opts[.peripheralUUIDs] = Array(known.keys) }
        c.registerForConnectionEvents(options: opts)
    }

    nonisolated func centralManagerDidUpdateState(_ c: CBCentralManager) {
        MainActor.assumeIsolated {
            let states = ["unknown", "resetting", "unsupported", "unauthorized", "off", "on"]
            log("bluetooth", ["state": states[min(c.state.rawValue, 5)], "auth": CBManager.authorization.rawValue])
            if c.state == .poweredOn { snapshot(c, why: "bluetooth on") }
        }
    }

    nonisolated func centralManager(_ c: CBCentralManager, willRestoreState dict: [String: Any]) {
        MainActor.assumeIsolated { log("relaunched by Bluetooth", ["keys": Array(dict.keys)]) }
    }

    nonisolated func centralManager(_ c: CBCentralManager, connectionEventDidOccur event: CBConnectionEvent,
                                    for peripheral: CBPeripheral) {
        MainActor.assumeIsolated {
            let state = event == .peerConnected ? "connected" : "disconnected"
            // iOS answers every registerForConnectionEvents with the current state of each match, so
            // re-registering from here on every event is an endless loop on the main queue. Re-register
            // only when a peripheral is new, and log only a change of state.
            let isNew = known[peripheral.identifier] == nil
            known[peripheral.identifier] = peripheral.name ?? known[peripheral.identifier] ?? "?"
            guard lastState[peripheral.identifier] != state else { return }
            lastState[peripheral.identifier] = state
            log(state, ["name": peripheral.name ?? "?", "id": peripheral.identifier.uuidString.prefix(8).description])
            if isNew { register(c) }
        }
    }

    /// From `WatchLink`'s WCSessionDelegate, on its queue.
    nonisolated static func observe(_ s: WCSession, _ why: String) {
        let fields: [String: Any] = ["why": why, "paired": s.isPaired, "installed": s.isWatchAppInstalled,
                                     "reachable": s.isReachable, "activation": s.activationState.rawValue]
        Task { @MainActor in shared.log("watch session", fields) }
    }

    private func log(_ what: String, _ fields: [String: Any]) {
        var line = fields
        line["kind"] = what
        ClientLog.note("watch-link", line)
        ElevatorUnlock.shared.event("watch link: \(what)", fields)
    }
}
#endif
