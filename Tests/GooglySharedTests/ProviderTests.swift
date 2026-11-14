import XCTest
@testable import GooglyShared

final class ProviderTests: XCTestCase {
    func testGenericAnswerIsParsedAndRenormalised() throws {
        let text = "```json\n{\"activity\":\"off_task\",\"probabilities\":{\"on_task\":0.2,\"off_task\":0.7,\"uncertain\":0.2},\"confidence\":0.8}\n```"
        let decision = try FocusDecision.decodeGeneric(text)
        XCTAssertEqual(decision.activity, .offTask)
        XCTAssertEqual(decision.probability, 0.7 / 1.1, accuracy: 0.0001)
        XCTAssertEqual(decision.confidence, 0.8)
        XCTAssertThrowsError(try FocusDecision.decodeGeneric("{\"activity\":\"browsing\",\"probabilities\":{}}"))
        XCTAssertThrowsError(try FocusDecision.decodeGeneric("not json"))
    }

    func testAllFourCombinedAveragesProbabilities() throws {
        let off = try FocusDecision.decodeGeneric("{\"activity\":\"off_task\",\"probabilities\":{\"on_task\":0.1,\"off_task\":0.9,\"uncertain\":0},\"confidence\":0.9}")
        let on = try FocusDecision.decodeGeneric("{\"activity\":\"on_task\",\"probabilities\":{\"on_task\":0.8,\"off_task\":0.1,\"uncertain\":0.1},\"confidence\":0.7}")
        let combined = try XCTUnwrap(FocusDecision.combine([off, on, on]))
        XCTAssertEqual(combined.activity, .onTask)
        XCTAssertEqual(combined.probability, (0.9 + 0.1 + 0.1) / 3, accuracy: 0.0001)
        XCTAssertNil(FocusDecision.combine([]))
        XCTAssertEqual(AIProvider.all.members.count, 4)
    }

    func testColoursHaveUniqueNames() {
        XCTAssertEqual(Set(BerryColour.all.map(\.id)).count, BerryColour.all.count)
        XCTAssertEqual(BerryColour.named("GREENIE"), .greenie)
        XCTAssertNil(BerryColour.named("plaid"))
    }
}
