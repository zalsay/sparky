import React from 'react'
import { SparkyApp } from '@sparky/frontend-core'
import { createWebPlatformClient } from '@sparky/platform-web'

const client = createWebPlatformClient()

export default function App(): React.ReactElement {
  return <SparkyApp client={client} />
}
