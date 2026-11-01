# ことばの正体 — GitHub Pages / Firebase Spark版

ブラウザーだけで動くワード当てゲームです。公開画面はGitHub Pages、匿名ログインとリアルタイム同期は既存FirebaseのAuthenticationとCloud Firestoreを使います。Cloud Functions、Cloud Scheduler、Firestore TTL、自動削除を使わず、Sparkプランの範囲で構成しています。

## ゲーム仕様

- 2〜8人。手番ごとに「質問」か「解答」の一方を選びます。
- 質問への回答は「はい／いいえ／たぶん」。誤答の解答は次の手番へ進みます。
- 解答者以外のプレイヤー全員が正誤投票し、最多票で判定します。同数は誤答扱いです。
- 勝者が複数いる場合も、最後にターンが回るプレイヤーまで進行します。
- 初期設定は時間制限なし。ゲーム終了時にホストが次回参加者を選びます。
- 途中参加者は観戦者。ホストが次回参加者として追加できます。途中復帰は同じブラウザの匿名UIDで再参加します。

## Firebase設定

1. FirebaseプロジェクトのAuthenticationで匿名ログインを有効にします。
2. Firestore Databaseを用意します。
3. Firebase ConsoleでWebアプリを登録し、API key、Auth domain、Project ID、App IDを取得します。
4. Authenticationの承認済みドメインにGitHub Pagesのホスト名（`owner.github.io`）を加えます。
5. `firestore.rules` を既存ルールに統合して公開します。既存環境の他アプリ用ルールを上書きしないでください。

ローカル起動時は `.env.example` を `.env` にコピーし、Firebaseの値を設定します。

```text
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=....firebaseapp.com
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=...
VITE_USE_EMULATORS=false
```

Node.js 22.12以降で `npm install`、`npm run dev` を実行します。GitHub PagesではActionsを有効にし、Repository variablesに `FIREBASE_API_KEY`、`FIREBASE_AUTH_DOMAIN`、`FIREBASE_PROJECT_ID`、`FIREBASE_APP_ID` を設定して `main` ブランチへpushします。Viteの環境変数はブラウザーに公開される設定値です。秘密鍵や管理者資格情報は置かないでください。

Firebase CLIでルールを適用する場合は、既存Firestoreルールと統合したファイルを確認したうえで適用してください。アプリ全体のルールを無確認で置き換えないこと。

## 無料枠と設計上の制約

この版はFirebase Sparkで使えるAuthenticationとFirestoreのみを使います。SparkにはFirestoreの日次読み取り・書き込み枠があり、リアルタイム同期も読み取りに数えられます。無料枠を超えた場合は利用制限されることがあります。最新の枠は[Firebase料金プラン](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)と[Firestoreクォータ](https://firebase.google.com/docs/firestore/quotas)を確認してください。

課金プラン専用のCloud Functions、Scheduler、TTLは含めていません。部屋は自動削除されずFirestoreに残るため、不要な部屋はFirebase Consoleから手動削除してください。

無料プランで動作させるため、ワード配布と投票集計は参加端末上で行います。Firestoreルールで自分のワードの読み取りを制限していますが、部屋作成者はブラウザーの開発者ツール等から処理や配布結果を調べられる可能性があります。また、投票確定処理はクライアント側です。したがって、悪意ある改造や共謀を含む不正を完全に防ぐ公平な大会用途には向きません。信頼できる参加者同士で遊ぶ想定です。

匿名UIDはブラウザーの保存データに紐づきます。同じブラウザー・保存状態で戻れば同じUIDで復帰できますが、別端末やブラウザーデータ消去後に本人を復元できません。

## ローカル確認

任意でFirebase Emulator Suiteを使う場合は `.env` の `VITE_USE_EMULATORS=true` にし、AuthとFirestoreのEmulatorを起動してから `npm run dev` を実行します。エミュレーターを使わない場合、ルール適用済みFirebaseプロジェクトが必要です。

## ファイル構成

```text
src/                  画面、Firebase接続、ゲーム処理、ワード候補
firestore.rules       クライアント利用向けFirestoreルール案
firebase.json         Auth / Firestore Emulator設定
.github/workflows/    GitHub Pages自動公開
```

## 運用上の注意

Firestoreルールはセキュリティ境界です。既存プロジェクトへ導入する際は、他アプリへの影響を確認して統合してください。部屋データを放置すると保存量や読み書きが増えるため、Consoleで定期的に不要データを整理してください。部屋内イベントは新しい順に全件表示する仕様です。
