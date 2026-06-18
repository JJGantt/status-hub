import Foundation

struct Status: Codable {
    let today: String?
    let litter: Litter?
    let nutrition: Nutrition?
    let maintenance: Maintenance?
    let workouts: [WorkoutDay]?
}

struct Litter: Codable {
    let status: String?
    let litter_level_pct: Double?
    let waste_drawer_pct: Double?
    let updated_at: String?
}

struct Macros: Codable {
    let calories: Double?
    let protein_g: Double?
    let carbs_g: Double?
    let fat_g: Double?
}

struct Nutrition: Codable {
    let calories: Double?
    let protein_g: Double?
    let carbs_g: Double?
    let fat_g: Double?
    let target: Macros?
}

struct Coverage: Codable {
    let weighins: Int?
    let need_weighins: Int?
    let intake_days: Int?
    let need_intake_days: Int?
    let intake_days_excluded: Int?
    let last_weighin_days_ago: Int?
    let last_intake_days_ago: Int?
}

struct Maintenance: Codable {
    let source: String?
    let maintenance: Double?
    let target: Double?
    let target_macros: Macros?
    let surplus: Double?
    let trend_lb_per_week: Double?
    let current_weight: Double?
    let coverage: Coverage?
}

struct WorkoutDay: Codable, Identifiable {
    let date: String
    let label: String?
    var id: String { date }
}
