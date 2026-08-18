// kilocode_change - new file
import { RemoteSessionService } from "../RemoteSessionService"
import { SessionManager } from "../../../../shared/kilocode/cli-sessions/core/SessionManager"
import { fetchSignedBlob } from "../../../../shared/kilocode/cli-sessions/utils/fetchBlobFromSignedUrl"

vi.mock("../../../../shared/kilocode/cli-sessions/core/SessionManager", () => ({ SessionManager: { init: vi.fn() } }))
vi.mock("../../../../shared/kilocode/cli-sessions/utils/fetchBlobFromSignedUrl", () => ({ fetchSignedBlob: vi.fn() }))

describe("RemoteSessionService resume metadata", () => {
	it("preserves cloud last_model", async () => {
		vi.mocked(SessionManager.init).mockReturnValue({
			getSession: vi.fn().mockResolvedValue({
				session_id: "remote",
				title: "Remote",
				created_at: "2026-01-01T00:00:00.000Z",
				last_mode: "code",
				last_model: "model-A",
			}),
		} as any)
		const result = await new RemoteSessionService({
			outputChannel: { appendLine: vi.fn() } as any,
		}).fetchSessionDataForResume("remote")
		expect(result?.metadata.model).toBe("model-A")
	})

	it("marks legacy cloud sessions with a null model", async () => {
		vi.mocked(SessionManager.init).mockReturnValue({
			getSession: vi.fn().mockResolvedValue({
				session_id: "legacy",
				title: "Legacy",
				created_at: "2026-01-01T00:00:00.000Z",
				last_mode: null,
			}),
		} as any)
		const result = await new RemoteSessionService({
			outputChannel: { appendLine: vi.fn() } as any,
		}).fetchSessionDataForResume("legacy")
		expect(result?.metadata.model).toBeNull()
		expect(fetchSignedBlob).not.toHaveBeenCalled()
	})
})
