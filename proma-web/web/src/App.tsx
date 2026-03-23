import React from 'react'
import { SparkyApp } from '@sparky/frontend-core'
import { createWebPlatformClient } from '@sparky/platform-web'
import type { UserProfile, WorkspaceCapabilities } from '@sparky/shared'

const FALLBACK_PROFILE: UserProfile = {
  displayName: 'Sparky User',
}

const FALLBACK_WORKSPACE_CAPABILITIES: WorkspaceCapabilities = {
  mcpServerCount: 0,
  skillCount: 0,
}

const client = createWebPlatformClient({
  getUserProfile: async () => FALLBACK_PROFILE,
  getWorkspaceCapabilities: async () => FALLBACK_WORKSPACE_CAPABILITIES,
})

export default function App(): React.ReactElement {
  return <SparkyApp client={client} />
}
