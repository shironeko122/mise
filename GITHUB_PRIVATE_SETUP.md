# GitHubプライベートリポジトリ設定メモ

## このアプリの考え方

GitHubのプライベートリポジトリは、アプリのコードを安全に置く場所として使います。
写真そのものはGitHubに保存せず、PCで起動したアプリの `data/` に一時保存します。

## GitHub Pagesで直接動かさない理由

このアプリは、iPhoneから画像を受け取り、PCでZIP化するためにNode.jsサーバーが必要です。
GitHub Pagesは静的サイト向けなので、Node.jsサーバーとしてのアップロード受信処理は動かせません。

## 推奨運用

1. プライベートリポジトリにこのアプリを入れる
2. PCにCloneまたはDownload ZIP
3. `start_windows.bat` で起動
4. iPhoneでQRを読む
5. PCでZIP保存
6. アルバム削除
7. 必要がなければサーバー停止

## 外から使う場合

外出先など同じWi-Fiでない場合、GitHubだけではPCに到達できません。
一時的に外部から使う場合は、Cloudflare TunnelなどでPCの `http://localhost:3000` を一時公開します。
公開URLが分かったら、起動前に `PUBLIC_BASE_URL` に設定してください。
