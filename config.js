/* 設定ファイル（ページと Service Worker の両方から読み込まれます） */
self.APP_CONFIG = {
  apiBase: 'https://api.p2pquake.net/v2',
  wsUrl: 'wss://api.p2pquake.net/v2/ws',
  historyLimit: 100,

  /* ---- FCM（プッシュ通知）: 未設定でも他の機能は動作します ---- */
  // Firebase コンソール > プロジェクトの設定 > マイアプリ(Web) の firebaseConfig
  firebase: {
    apiKey: 'AIzaSyC19Li_pytnDbyy_csICpuNyXK6PNfhXQQ',
    authDomain: 'quake-pwa.firebaseapp.com',
    projectId: 'quake-pwa',
    messagingSenderId: '128800659323',
    appId: '1:128800659323:web:37fc7a5bf7c4f987550fde'
  },
  // Firebase コンソール > Cloud Messaging > ウェブプッシュ証明書 の鍵ペア（公開鍵）
  vapidKey: 'BIW7kFrqKYh7qmzR-7RM2rKgVhXmqDZMgRF9lcQ6Et6FrTDeIFUr5S0Zaim1WZKEhkV5wdRsTAE_jUqwLWSDBME',
  // relay/ サーバーの公開URL（例: https://quake-relay.example.com）
  relayUrl: ''
};
