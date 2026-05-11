export function createRuntime() {
    return {
        async getSnapshot() {
            return {
                activeTarget: "/home/bangjyuhyeon/team404/test_folder",
                quarantineJobs: [
                    {
                        incidentId: "demo-incident-001",
                        rootPath: "/etc/passwd_backup",
                        entryCount: 5
                    }
                ]
            };
        },
        async restoreIncident(id) {
            console.log(`[INFO] Incident ${id} restored.`);
            return { success: true };
        }
    };
}