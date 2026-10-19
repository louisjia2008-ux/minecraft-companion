// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DeskPetMigrationHelper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "DeskPetMigrationHelper", targets: ["DeskPetMigrationHelper"]),
    ],
    targets: [
        .executableTarget(name: "DeskPetMigrationHelper"),
    ]
)
