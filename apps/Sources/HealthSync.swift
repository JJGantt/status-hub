#if os(iOS)
import Foundation
import HealthKit

// Everything else Apple Health holds, read and sent to the hub the way SleepSync sends sleep
// (docs/HEALTH.md). One observer and one anchored query over every type at once, so there is a single
// anchor to keep rather than one per type, and a type Health has no data for costs nothing.
//
// The anchor is saved only after the hub accepts a page: a failed post leaves it where it was and the
// next run sends the same samples again, which the hub's UUID-keyed upsert makes harmless. The first
// run is the whole history, so it goes in pages that each commit before the next is read — a
// background run that iOS cuts short resumes from the last page that landed.
final class HealthSync {
    static let shared = HealthSync()
    private let store = HKHealthStore()
    // One anchor covers every type, and it is a position in Health's whole history: a type added to the
    // lists below is read only from that position on. Adding one means changing this key, which
    // re-reads everything from the start (the upsert absorbs the resend).
    private let anchorKey = "healthAnchor"
    private let queue = DispatchQueue(label: "HealthSync")
    private var running = false
    private var units: [HKQuantityType: HKUnit] = [:]
    private static let pageSize = 2000

    // Identifiers without their `HKQuantityTypeIdentifier` prefix. Built by name rather than with the
    // enum cases so a type this SDK knows and an older iOS does not is skipped instead of crashing.
    private static let quantityNames = [
        // heart and vitals
        "HeartRate", "RestingHeartRate", "WalkingHeartRateAverage", "HeartRateVariabilitySDNN",
        "HeartRateRecoveryOneMinute", "AtrialFibrillationBurden", "OxygenSaturation", "RespiratoryRate",
        "BodyTemperature", "BasalBodyTemperature", "AppleSleepingWristTemperature",
        "AppleSleepingBreathingDisturbances", "BloodPressureSystolic", "BloodPressureDiastolic",
        "BloodGlucose", "PeripheralPerfusionIndex", "ElectrodermalActivity", "BloodAlcoholContent",
        "ForcedVitalCapacity", "ForcedExpiratoryVolume1", "PeakExpiratoryFlowRate", "InhalerUsage",
        "InsulinDelivery", "NumberOfTimesFallen", "NumberOfAlcoholicBeverages",
        // body
        "BodyMass", "BodyMassIndex", "BodyFatPercentage", "LeanBodyMass", "Height", "WaistCircumference",
        // activity
        "StepCount", "DistanceWalkingRunning", "DistanceCycling", "DistanceWheelchair", "DistanceSwimming",
        "DistanceDownhillSnowSports", "DistanceCrossCountrySkiing", "DistancePaddleSports", "DistanceRowing",
        "DistanceSkatingSports", "ActiveEnergyBurned", "BasalEnergyBurned", "FlightsClimbed",
        "AppleExerciseTime", "AppleStandTime", "AppleMoveTime", "PushCount", "SwimmingStrokeCount",
        "VO2Max", "PhysicalEffort", "WorkoutEffortScore", "EstimatedWorkoutEffortScore", "NikeFuel",
        "UnderwaterDepth", "WaterTemperature",
        // running, cycling and other workout metrics
        "RunningSpeed", "RunningPower", "RunningStrideLength", "RunningVerticalOscillation",
        "RunningGroundContactTime", "CyclingSpeed", "CyclingPower", "CyclingCadence",
        "CyclingFunctionalThresholdPower", "CrossCountrySkiingSpeed", "PaddleSportsSpeed", "RowingSpeed",
        // mobility
        "WalkingSpeed", "WalkingStepLength", "WalkingAsymmetryPercentage", "WalkingDoubleSupportPercentage",
        "StairAscentSpeed", "StairDescentSpeed", "SixMinuteWalkTestDistance", "AppleWalkingSteadiness",
        // environment and hearing
        "EnvironmentalAudioExposure", "HeadphoneAudioExposure", "EnvironmentalSoundReduction",
        "UVExposure", "TimeInDaylight",
        // nutrition other apps write to Health
        "DietaryEnergyConsumed", "DietaryProtein", "DietaryCarbohydrates", "DietaryFatTotal",
        "DietaryFatSaturated", "DietaryFatMonounsaturated", "DietaryFatPolyunsaturated", "DietaryCholesterol",
        "DietarySodium", "DietaryFiber", "DietarySugar", "DietaryWater", "DietaryCaffeine", "DietaryCalcium",
        "DietaryIron", "DietaryPotassium", "DietaryVitaminA", "DietaryVitaminB6", "DietaryVitaminB12",
        "DietaryVitaminC", "DietaryVitaminD", "DietaryVitaminE", "DietaryVitaminK", "DietaryFolate",
        "DietaryMagnesium", "DietaryZinc", "DietaryThiamin", "DietaryRiboflavin", "DietaryNiacin",
        "DietaryPantothenicAcid", "DietaryBiotin", "DietaryPhosphorus", "DietaryIodine", "DietarySelenium",
        "DietaryCopper", "DietaryManganese", "DietaryChromium", "DietaryMolybdenum", "DietaryChloride",
    ]

    // Sleep is not here: SleepSync owns it, into its own table.
    private static let categoryNames = [
        "AppleStandHour", "MindfulSession", "HighHeartRateEvent", "LowHeartRateEvent",
        "IrregularHeartRhythmEvent", "LowCardioFitnessEvent", "AppleWalkingSteadinessEvent", "SleepApneaEvent",
        "EnvironmentalAudioExposureEvent", "HeadphoneAudioExposureEvent", "HandwashingEvent",
        "ToothbrushingEvent",
    ]

    private static let quantityTypes: [HKQuantityType] = quantityNames.compactMap {
        HKObjectType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: "HKQuantityTypeIdentifier" + $0))
    }
    private static let categoryTypes: [HKCategoryType] = categoryNames.compactMap {
        HKObjectType.categoryType(forIdentifier: HKCategoryTypeIdentifier(rawValue: "HKCategoryTypeIdentifier" + $0))
    }
    private static var allTypes: [HKSampleType] {
        quantityTypes.map { $0 as HKSampleType } + categoryTypes.map { $0 as HKSampleType } + [HKObjectType.workoutType()]
    }

    // Must run on every launch, including the background relaunch HealthKit does to deliver — which is
    // why it is called from didFinishLaunching rather than from a view.
    func start() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let types = Self.allTypes
        // Sleep is asked for in the same sheet, and SleepSync starts only once it has been answered, so
        // its own request finds the question settled instead of putting a second sheet up beside this one.
        store.requestAuthorization(toShare: [], read: Set(types).union([HKCategoryType(.sleepAnalysis)])) { [weak self] _, _ in
            SleepSync.shared.start()
            guard let self else { return }
            self.loadUnits {
                let observer = HKObserverQuery(queryDescriptors: types.map { HKQueryDescriptor(sampleType: $0, predicate: nil) }) { [weak self] _, _, done, error in
                    guard error == nil, let self else { return done() }
                    self.sync(then: done)
                }
                self.store.execute(observer)
                for t in types { self.store.enableBackgroundDelivery(for: t, frequency: .immediate) { _, _ in } }
            }
        }
    }

    // The unit Health itself displays for each type. Asked for as a whole first; a type it refuses
    // fails the whole set, so on an error each is asked for alone and the refused ones are skipped.
    private func loadUnits(then done: @escaping () -> Void) {
        let types = Set(Self.quantityTypes)
        store.preferredUnits(for: types) { [weak self] map, error in
            guard let self else { return }
            if error == nil { return self.queue.async { self.units = map; done() } }
            let group = DispatchGroup()
            var found: [HKQuantityType: HKUnit] = [:]
            let lock = NSLock()
            for t in types {
                group.enter()
                self.store.preferredUnits(for: [t]) { m, _ in
                    lock.lock(); found.merge(m) { a, _ in a }; lock.unlock()
                    group.leave()
                }
            }
            group.notify(queue: self.queue) { self.units = found; done() }
        }
    }

    // One run at a time: the observer fires at launch and again on every delivery, and two runs from
    // the same anchor would post the same pages twice.
    private func sync(then done: @escaping () -> Void) {
        queue.async {
            if self.running { return done() }
            self.running = true
            self.page(from: self.loadAnchor()) {
                self.queue.async { self.running = false }
                done()
            }
        }
    }

    private func page(from anchor: HKQueryAnchor?, then done: @escaping () -> Void) {
        let descriptors = Self.allTypes.map { HKQueryDescriptor(sampleType: $0, predicate: nil) }
        let q = HKAnchoredObjectQuery(queryDescriptors: descriptors, anchor: anchor, limit: Self.pageSize) { [weak self] _, added, deleted, next, error in
            guard let self, error == nil, let next else { return done() }
            self.queue.async {
                let rows = (added ?? []).compactMap(self.row)
                let gone = (deleted ?? []).map { $0.uuid.uuidString }
                let full = (added?.count ?? 0) + (deleted?.count ?? 0) >= Self.pageSize
                if rows.isEmpty && gone.isEmpty {
                    self.saveAnchor(next)
                    return full ? self.page(from: next, then: done) : done()
                }
                self.post(rows, gone) { ok in
                    guard ok else { return done() }
                    self.saveAnchor(next)
                    // A full page means there may be more behind it.
                    full ? self.page(from: next, then: done) : done()
                }
            }
        }
        store.execute(q)
    }

    private static let iso = ISO8601DateFormatter()

    // Called on `queue`, which is the only place `units` is read or written.
    private func row(_ s: HKSample) -> [String: Any]? {
        var r: [String: Any] = ["id": s.uuid.uuidString, "start": Self.iso.string(from: s.startDate),
                                "end": Self.iso.string(from: s.endDate), "source": s.sourceRevision.source.name]
        var meta = Self.json(s.metadata ?? [:])
        if let q = s as? HKQuantitySample {
            guard let unit = units[q.quantityType], q.quantity.is(compatibleWith: unit) else { return nil }
            r["type"] = Self.short(q.quantityType.identifier, "HKQuantityTypeIdentifier")
            let v = q.quantity.doubleValue(for: unit)
            guard v.isFinite else { return nil }
            r["value"] = v
            r["unit"] = unit.unitString
        } else if let c = s as? HKCategorySample {
            r["type"] = Self.short(c.categoryType.identifier, "HKCategoryTypeIdentifier")
            r["value"] = c.value
        } else if let w = s as? HKWorkout {
            r["type"] = "workout"
            r["label"] = Self.activityName(w.workoutActivityType)
            r["value"] = w.duration
            r["unit"] = "s"
            var stats: [String: Any] = [:]
            for (t, st) in w.allStatistics {
                guard let unit = units[t] else { continue }
                var e: [String: Any] = ["unit": unit.unitString]
                // A NaN anywhere fails the whole page's JSON, and an unpostable page stalls the anchor.
                for (k, q) in [("avg", st.averageQuantity()), ("min", st.minimumQuantity()),
                               ("max", st.maximumQuantity()), ("sum", st.sumQuantity())] {
                    if let v = q?.doubleValue(for: unit), v.isFinite { e[k] = v }
                }
                stats[Self.short(t.identifier, "HKQuantityTypeIdentifier")] = e
            }
            if !stats.isEmpty { meta["stats"] = stats }
            meta["activity_raw"] = w.workoutActivityType.rawValue
        } else {
            return nil
        }
        if !meta.isEmpty { r["metadata"] = meta }
        return r
    }

    // `HKQuantityTypeIdentifierHeartRate` -> `heartRate`.
    private static func short(_ id: String, _ prefix: String) -> String {
        let s = id.hasPrefix(prefix) ? String(id.dropFirst(prefix.count)) : id
        return s.prefix(1).lowercased() + s.dropFirst()
    }

    // HealthKit metadata values are strings, numbers, dates and quantities; JSON takes the first two.
    private static func json(_ m: [String: Any]) -> [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in m {
            let key = k.hasPrefix("HKMetadataKey") ? String(k.dropFirst("HKMetadataKey".count)) : k
            switch v {
            case let s as String: out[key] = s
            case let n as NSNumber: if n.doubleValue.isFinite { out[key] = n }
            case let d as Date: out[key] = iso.string(from: d)
            case let q as HKQuantity: out[key] = q.description
            default: out[key] = String(describing: v)
            }
        }
        return out
    }

    private static func activityName(_ t: HKWorkoutActivityType) -> String {
        switch t {
        case .traditionalStrengthTraining: return "traditionalStrengthTraining"
        case .functionalStrengthTraining: return "functionalStrengthTraining"
        case .coreTraining: return "coreTraining"
        case .highIntensityIntervalTraining: return "highIntensityIntervalTraining"
        case .crossTraining: return "crossTraining"
        case .mixedCardio: return "mixedCardio"
        case .running: return "running"
        case .walking: return "walking"
        case .hiking: return "hiking"
        case .cycling: return "cycling"
        case .swimming: return "swimming"
        case .surfingSports: return "surfing"
        case .paddleSports: return "paddleSports"
        case .waterSports: return "waterSports"
        case .rowing: return "rowing"
        case .elliptical: return "elliptical"
        case .stairClimbing: return "stairClimbing"
        case .stairs: return "stairs"
        case .yoga: return "yoga"
        case .pilates: return "pilates"
        case .flexibility: return "flexibility"
        case .cooldown: return "cooldown"
        case .preparationAndRecovery: return "preparationAndRecovery"
        case .mindAndBody: return "mindAndBody"
        case .dance: return "dance"
        case .jumpRope: return "jumpRope"
        case .boxing: return "boxing"
        case .kickboxing: return "kickboxing"
        case .martialArts: return "martialArts"
        case .climbing: return "climbing"
        case .golf: return "golf"
        case .tennis: return "tennis"
        case .pickleball: return "pickleball"
        case .basketball: return "basketball"
        case .soccer: return "soccer"
        case .volleyball: return "volleyball"
        case .skatingSports: return "skating"
        case .snowSports: return "snowSports"
        case .downhillSkiing: return "downhillSkiing"
        case .snowboarding: return "snowboarding"
        case .other: return "other"
        default: return "activity\(t.rawValue)"
        }
    }

    private func post(_ samples: [[String: Any]], _ deleted: [String], done: @escaping (Bool) -> Void) {
        guard let url = URL(string: Auth.host + "/api/health/samples"), let token = Auth.token(),
              let body = try? JSONSerialization.data(withJSONObject: ["samples": samples, "deleted": deleted])
        else { return done(false) }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.timeoutInterval = 60
        r.setValue(token, forHTTPHeaderField: "X-Hub-Token")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = body
        URLSession.shared.dataTask(with: r) { _, resp, err in
            done(err == nil && (resp as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    private func loadAnchor() -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: anchorKey) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func saveAnchor(_ a: HKQueryAnchor) {
        if let data = try? NSKeyedArchiver.archivedData(withRootObject: a, requiringSecureCoding: true) {
            UserDefaults.standard.set(data, forKey: anchorKey)
        }
    }
}
#endif
