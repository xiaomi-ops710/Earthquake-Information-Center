/* 設定ファイル（ページと Service Worker の両方から読み込まれます） */
self.APP_CONFIG = {
  apiBase: 'https://api.p2pquake.net/v2',
  wsUrl: 'wss://api.p2pquake.net/v2/ws',
  historyLimit: 100,

  /* ---- FCM（プッシュ通知）: 未設定でも他の機能は動作します ---- */
  // Firebase コンソール > プロジェクトの設定 > マイアプリ(Web) の firebaseConfig
  firebase: {
    apiKey: '',
    authDomain: '',
    projectId: '',
    messagingSenderId: '',
    appId: ''
  },
  // Firebase コンソール > Cloud Messaging > ウェブプッシュ証明書 の鍵ペア（公開鍵）
  vapidKey: '',
  // relay/ サーバーの公開URL（例: https://quake-relay.example.com）
  relayUrl: ''
};
