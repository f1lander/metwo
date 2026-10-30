import { useEffect, useState } from 'react'

export type SettingsTab = 'general' | 'budget' | 'engines' | 'integrations' | 'status'
const TABS: readonly SettingsTab[] = ['general', 'budget', 'engines', 'integrations', 'status']

export type Route = { readonly page: 'home' } | { readonly page: 'board' } | { readonly page: 'reviews' } | { readonly page: 'review'; readonly id: string } | { readonly page: 'ticket'; readonly id: string } | { readonly page: 'settings'; readonly tab: SettingsTab } | { readonly page: 'learnings' }

function parse(hash: string): Route {
  const ticket = /^#\/t\/([A-Za-z]+-\d+)/.exec(hash)
  if (ticket?.[1]) return { page: 'ticket', id: ticket[1] }
  const review = /^#\/r\/(PR-\d+)/.exec(hash)
  if (review?.[1]) return { page: 'review', id: review[1] }
  if (hash.startsWith('#/reviews')) return { page: 'reviews' }
  if (hash.startsWith('#/health')) return { page: 'settings', tab: 'status' }
  const settings = /^#\/settings(?:\/(\w+))?/.exec(hash)
  if (settings) return { page: 'settings', tab: TABS.find((t) => t === settings[1]) ?? 'general' }
  if (hash.startsWith('#/learnings')) return { page: 'learnings' }
  if (hash.startsWith('#/board')) return { page: 'board' }
  return { page: 'home' }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export const href = {
  home: '#/',
  board: '#/board',
  ticket: (id: string) => `#/t/${id}`,
  reviews: '#/reviews',
  review: (id: string) => `#/r/${id}`,
  settings: (tab?: SettingsTab) => (tab ? `#/settings/${tab}` : '#/settings'),
  health: '#/settings/status',
  learnings: '#/learnings',
}
