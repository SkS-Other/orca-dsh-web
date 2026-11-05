import { defineCheck } from 'orca/testing'

export default defineCheck({
  empty: {},
  project: {
    results: {
      'workspace.readContext': {
        displayName: 'Проект',
        branch: 'main',
        terminals: [],
      },
      'workspace.list': {
        workspaces: [
          {
            id: 'repo::/project',
            kind: 'worktree',
            name: 'Проект',
            path: '/project',
            branch: 'main',
            hostId: 'local',
          },
        ],
        truncated: false,
      },
    },
  },
})
