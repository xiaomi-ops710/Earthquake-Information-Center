# 地震・津波速報 PWA

P2P地震情報 API（REST `/history` + WebSocket）を使うリアルタイム地震・津波速報。Material 3 Expressive ダークUI、Leaflet 地図、localStorage キャッシュ、FCM プッシュ対応。

## 構成
- `index.html / css/app.css / js/app.js` … アプリ本体（ビルド不要）
- `sw.js` … オフラインキャッシュ + FCM バックグラウンド通知
- `config.js` … Firebase / 中継サーバーURL の設定
- `relay/` … P2P WebSocket → FCM 即時送信サーバー（Node 18+）

## 1. GitHub Pages で公開
このフォルダの中身（`relay/` は除いても可）をリポジトリ直下に置き、Settings → Pages で `main` / root を公開。
すべて相対パスなので `/<repo>/` のサブパスでも動きます。

## 2. iPad にインストール
Safari で開く → 共有 → 「ホーム画面に追加」。iOS 16.4+ ではインストール後の PWA のみ Web Push が使えます。
起動後、設定（歯車）から通知を許可してください。

## 3. FCM（即時プッシュ）を有効にする
GitHub Pages は静的ホスティングのため、FCM の送信側は `relay/` を別途常時稼働させます。
1. Firebase プロジェクト作成 → Web アプリ追加 → `firebaseConfig` を `config.js` の `firebase` に、Cloud Messaging の「ウェブプッシュ証明書」公開鍵を `vapidKey` に設定。
2. サービスアカウント鍵（JSON）を発行。
3. `relay/` を Render / Fly.io / Railway / VPS 等へデプロイ（WebSocket 常時接続のため、スリープしない構成で）。
   - `FIREBASE_SERVICE_ACCOUNT` = JSON 文字列
   - `ALLOWED_ORIGIN` = `https://<user>.github.io`
4. 公開URLを `config.js` の `relayUrl` に設定。
5. アプリの設定で「プッシュ通知（FCM）」をオン。

端末は震度しきい値別トピック `quake-min-{10,30,40,45,55}` のどれか1つに登録され、中継サーバーが受信と同時に該当トピックへ送信します（津波・緊急地震速報は全端末へ）。

## 補足
- Leaflet は unpkg（v1.9.4 固定）から読み込み、初回アクセス後は SW がキャッシュします。自己完結にしたい場合は `vendor/` に置き、`index.html` と `sw.js` のURLを差し替えてください。
- 地図タイルは CARTO（OSM）です。商用利用時は規約を確認してください。
- `sw.js` を変更したら `VER` を上げるとキャッシュが更新されます。
