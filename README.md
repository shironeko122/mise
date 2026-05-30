# iPhone Photo Bridge v1.1.0

GitHubのプライベートリポジトリで管理し、必要な時だけPCで起動して使う、iPhone画像の一時転送アプリです。

## 重要な方針

- GitHubはアプリ置き場として使います。
- 写真データはGitHubへアップロードしません。
- 写真データはPC内の `data/` フォルダへ一時保存します。
- PCでZIP保存したら、画面の「アルバム削除」で一時データを消してください。
- GitHub Pagesだけでは、このアプリのような画像アップロード受信サーバーは動きません。PCでNode.jsサーバーとして起動します。

## できること

- PCで一時アルバム作成
- PIN付き共有
- QRコード表示
- iPhoneで複数画像アップロード
- PCでアルバム単位ZIP保存
- 24時間で期限切れ
- 保存後の手動削除
- 同じWi-Fi用のLAN URL自動表示
- `PUBLIC_BASE_URL` 指定による一時トンネルURL対応

## GitHubプライベートリポジトリで使う流れ

### 1. GitHubでプライベートリポジトリを作る

例: `iphone-photo-bridge-private`

### 2. このZIPの中身をリポジトリへ入れる

リポジトリ直下に、以下が見える状態にしてください。

- `server.js`
- `package.json`
- `public/`
- `start_windows.bat`
- `diagnose_windows.bat`

### 3. PCへ取得する

おすすめはGitHub Desktopです。

1. GitHub Desktopでログイン
2. `File` → `Clone repository`
3. 作成したプライベートリポジトリを選択
4. PC上の保存先を選んでClone

Web画面だけで使う場合は、GitHubのリポジトリ画面から `Code` → `Download ZIP` でも構いません。

### 4. 起動する

Windowsでは `start_windows.bat` をダブルクリックしてください。

手動で起動する場合:

```bash
npm install
npm start
```

起動後、PCで以下を開きます。

```text
http://localhost:3000
```

## iPhoneから接続する方法

### 同じWi-Fi内で使う場合

PC画面に表示されるQRコードをiPhoneで読み取ってください。

v1.1.0では、PCで `localhost` を開いていても、QRコードには可能な範囲で以下のようなLAN用URLを使います。

```text
http://192.168.x.x:3000
```

うまく開けない場合は、Windows Defender ファイアウォールでNode.jsの通信許可が必要な場合があります。

### 外出先や別ネットワークから使う場合

GitHubだけでは外部からPCへ接続できません。必要な時だけ、Cloudflare Tunnelなどの一時公開URLを作り、そのURLを `PUBLIC_BASE_URL` として指定してください。

例:

```bat
set PUBLIC_BASE_URL=https://example.trycloudflare.com
npm start
```

この場合、QRコードや共有URLは `PUBLIC_BASE_URL` を優先します。

## 環境変数

| 変数 | 既定値 | 内容 |
|---|---:|---|
| `PORT` | 3000 | 起動ポート |
| `TTL_HOURS` | 24 | アルバム有効期限。最大24時間 |
| `MAX_UPLOAD_MB` | 150 | 1ファイル最大サイズMB |
| `MAX_FILES_PER_ALBUM` | 500 | 1アルバム最大枚数 |
| `MAX_ALBUM_MB` | 2000 | 1アルバム最大容量MB |
| `UPLOAD_DIR` | `./data` | 画像一時保存先 |
| `PUBLIC_BASE_URL` | なし | Cloudflare Tunnel等の外部公開URL |

## 使い方

1. PCでトップページを開く
2. アルバム名とPINを入力して作成
3. 表示されたQRコードをiPhoneで読み取る
4. iPhone側でPINを入力して画像を選択、アップロード
5. PC側で「最新情報取得」または自動表示を確認
6. 「アルバムをZIP保存」で保存
7. 保存後、「アルバム削除」でPC側の一時画像を消す

## セキュリティ上の注意

- URLを知っていてもPINがないと閲覧・アップロード・ダウンロードはできません。
- ただし、本格的なクラウドストレージではありません。
- 不特定多数に公開する用途には向きません。
- Cloudflare Tunnel等で外部公開する場合は、必要な間だけ起動し、終わったら停止してください。
- GitHubに `data/`、`node_modules/`、`.env` をコミットしないでください。`.gitignore` で除外済みです。

## iPhone側の注意

- Safariのファイル選択で「写真ライブラリ」から複数選択できます。
- HEICは元ファイルのままZIPに入ります。
- iCloud上にのみある写真は、iPhone側で読み込みに時間がかかる場合があります。
