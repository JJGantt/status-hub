import SwiftUI

struct CardBox<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold)).tracking(1.2).foregroundColor(.muted)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(Color.card)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.cardBorder, lineWidth: 1))
    }
}

struct StatRow: View {
    let label: String
    let value: String
    var color: Color = .white
    var body: some View {
        HStack {
            Text(label).foregroundColor(.muted)
            Spacer()
            Text(value).fontWeight(.semibold).foregroundColor(color)
        }
        .padding(.top, 6)
        .overlay(Divider().background(Color.cardBorder), alignment: .top)
    }
}

struct MacroTile: View {
    let name: String
    let value: Double?
    let target: Double?
    var body: some View {
        VStack(spacing: 2) {
            Text(gint(value) + "g").font(.title3.bold())
            Text(target == nil ? name : "\(name) / \(gint(target))g")
                .font(.caption2).foregroundColor(.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(Color.tile)
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

struct LitterCard: View {
    let litter: Litter?
    var body: some View {
        CardBox(title: "Litter-Robot") {
            HStack(spacing: 10) {
                Circle().fill(hexColor(litter?.color)).frame(width: 12, height: 12)
                Text(litter?.label ?? "—").font(.title2.bold())
            }
            StatRow(label: "Used", value: litter?.used_ago ?? "—", color: .primary)
            StatRow(label: "Litter level", value: pctText(litter?.litter_level_pct), color: litterColor(litter?.litter_level_pct))
            StatRow(label: "Waste drawer", value: pctText(litter?.waste_drawer_pct), color: drawerColor(litter?.waste_drawer_pct))
        }
    }
}

struct NutritionCard: View {
    let nutrition: Nutrition?
    var body: some View {
        let n = nutrition
        let t = nutrition?.target
        CardBox(title: "Today · Nutrition") {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(gint(n?.calories)).font(.system(size: 40, weight: .bold))
                Text(t?.calories != nil ? "/ \(gint(t?.calories)) cal" : "cal")
                    .font(.title3).foregroundColor(.muted)
            }
            HStack(spacing: 10) {
                MacroTile(name: "Protein", value: n?.protein_g, target: t?.protein_g)
                MacroTile(name: "Carbs", value: n?.carbs_g, target: t?.carbs_g)
                MacroTile(name: "Fat", value: n?.fat_g, target: t?.fat_g)
            }
        }
    }
}

struct MaintenanceCard: View {
    let m: Maintenance?
    var body: some View {
        let live = (m?.source == "live")
        CardBox(title: "Maintenance · Goal") {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(gint(m?.maintenance)).font(.system(size: 40, weight: .bold))
                Text("cal/day").font(.title3).foregroundColor(.muted)
            }
            Text("estimated maintenance · " + (live ? "measured" : "cold-start anchor"))
                .font(.footnote).foregroundColor(.muted)
            StatRow(label: "Recommended goal", value: "\(gint(m?.target)) cal (+\(gint(m?.surplus)))")
            StatRow(label: "Weight trend", value: trendText, color: trendColor)
            Text(dataLine).font(.footnote)
                .foregroundColor(live ? .muted : Color(hex: 0xeab308))
                .padding(.top, 4)
        }
    }
    private var trendText: String {
        guard let t = m?.trend_lb_per_week else { return "—" }
        let sign = t > 0 ? "▲ +" : (t < 0 ? "▼ " : "± ")
        return sign + String(format: "%.2f lb/wk", t)
    }
    private var trendColor: Color {
        guard let t = m?.trend_lb_per_week else { return .muted }
        return t > 0 ? Color(hex: 0x22c55e) : (t < 0 ? Color(hex: 0xf97316) : .muted)
    }
    private var dataLine: String {
        let c = m?.coverage
        if m?.source == "live" {
            let ex = (c?.intake_days_excluded ?? 0) > 0 ? " (\(c!.intake_days_excluded!) under-logged ignored)" : ""
            return "Live · \(c?.weighins ?? 0) weigh-ins & \(c?.intake_days ?? 0) logged days" + ex
        }
        let nW = max(0, (c?.need_weighins ?? 0) - (c?.weighins ?? 0))
        let nI = max(0, (c?.need_intake_days ?? 0) - (c?.intake_days ?? 0))
        return "Calibrating — need \(nW) more weigh-in\(nW == 1 ? "" : "s"), \(nI) more logged day\(nI == 1 ? "" : "s")."
    }
}

struct WorkoutsCard: View {
    let days: [WorkoutDay]
    private func dow(_ date: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "America/New_York")
        guard let d = f.date(from: date) else { return "" }
        let o = DateFormatter(); o.dateFormat = "EEE"; o.timeZone = TimeZone(identifier: "America/New_York")
        return o.string(from: d)
    }
    var body: some View {
        CardBox(title: "Workouts · Last 7 Days") {
            HStack(spacing: 6) {
                ForEach(days) { d in
                    VStack(spacing: 6) {
                        Text(dow(d.date)).font(.caption2).foregroundColor(.muted)
                        Text(d.label ?? "—")
                            .font(.caption2.weight(.semibold))
                            .foregroundColor(d.label == nil ? Color(hex: 0x3a434f) : dayColor(d.label))
                            .multilineTextAlignment(.center)
                            .frame(minHeight: 34)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color.tile)
                    .overlay(Rectangle().fill(dayColor(d.label)).frame(height: 3), alignment: .top)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
        }
    }
}
