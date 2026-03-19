/**
 * ClawApp Service Worker
 * 功能：
 * - 静态资源缓存
 * - 离线支持
 * - Web Push 通知
 * - 后台同步
 */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'
const CACHE_NAME = `clawapp-${VERSION}`
const APP_SHELL_CACHE = `clawapp-shell-${VERSION}`

// 需要缓存的静态资源
const STATIC_ASSETS = [
  '/manifest.json',
  '/favicon.svg',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png'
]

// ============ 安装阶段 ============
self.addEventListener('install', event => {
  console.log('[SW] Installing...')
  
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching static assets')
      return cache.addAll(STATIC_ASSETS)
    }).then(() => {
      // 立即激活，跳过等待
      return self.skipWaiting()
    })
  )
})

// ============ 激活阶段 ============
self.addEventListener('activate', event => {
  console.log('[SW] Activating...')
  
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => {
            console.log('[SW] Deleting old cache:', name)
            return caches.delete(name)
          })
      )
    }).then(() => {
      // 立即控制所有页面
      return self.clients.claim()
    })
  )
})

// ============ 抓取阶段 ============
self.addEventListener('fetch', event => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  
  // Skip cross-origin requests
  if (url.origin !== location.origin) {
    return
  }

  // API/SSE 一律直连网络，避免脏缓存
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    event.respondWith(networkOnly(request))
    return
  }

  // HTML 导航优先拿网络，确保入口页尽快更新到新版本
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(networkFirstPage(request))
    return
  }

  // 带 hash 的静态资源适合缓存优先
  event.respondWith(cacheFirst(request))
})

// ============ 缓存优先策略 ============
async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) {
    return cached
  }
  
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME)
      cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    return caches.match(request)
  }
}

// ============ 页面网络优先策略 ============
async function networkFirstPage(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(APP_SHELL_CACHE)
      cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    const cached = await caches.match(request)
    return cached || caches.match('/index.html')
  }
}

// ============ API 直连网络 ============
async function networkOnly(request) {
  try {
    return await fetch(request)
  } catch (error) {
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// ============ Push 通知 ============
self.addEventListener('push', event => {
  console.log('[SW] Push received:', event.data ? event.data.text() : 'no data')
  
  let data = { title: 'ClawApp', body: '您有新消息' }
  
  if (event.data) {
    try {
      data = event.data.json()
    } catch (e) {
      data.body = event.data.text()
    }
  }
  
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    tag: data.tag || 'default',
    renotify: true,
    data: data.data || {},
    actions: data.actions || [
      { action: 'open', title: '打开' },
      { action: 'dismiss', title: '忽略' }
    ]
  }
  
  event.waitUntil(
    self.registration.showNotification(data.title, options)
  )
})

// ============ 通知点击 ============
self.addEventListener('notificationclick', event => {
  console.log('[SW] Notification click:', event.action)
  
  event.notification.close()
  
  if (event.action === 'dismiss') {
    return
  }
  
  // 默认行为：打开或聚焦页面
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // 如果有已打开的页面，聚焦它
        for (const client of clientList) {
          if (client.url === '/' && 'focus' in client) {
            return client.focus()
          }
        }
        // 否则打开新页面
        if (clients.openWindow) {
          return clients.openWindow('/')
        }
      })
      .then(() => {
        // 通知主页面点击了通知
        return clients.matchAll({ type: 'window' })
      })
      .then(clientList => {
        for (const client of clientList) {
          client.postMessage({
            type: 'notificationclick',
            notification: {
              title: event.notification.title,
              body: event.notification.body,
              data: event.notification.data
            }
          })
        }
      })
  )
})

// ============ 后台同步 ============
self.addEventListener('sync', event => {
  console.log('[SW] Background sync:', event.tag)
  
  if (event.tag === 'sync-messages') {
    event.waitUntil(syncMessages())
  }
})

async function syncMessages() {
  // 获取缓存的消息并发送
  const cache = await caches.open(CACHE_NAME)
  const requests = await cache.keys()
  
  for (const request of requests) {
    if (request.url.includes('/api/messages')) {
      try {
        await fetch(request)
      } catch (e) {
        console.log('[SW] Failed to sync:', request.url)
      }
    }
  }
}

// ============ 消息处理（主页面通信）===========
self.addEventListener('message', event => {
  console.log('[SW] Message:', event.data)
  
  if (event.data && event.data.type === 'skipWaiting') {
    self.skipWaiting()
  }
})
