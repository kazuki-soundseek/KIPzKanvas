# KIPzKanvas 開発メモ（Claude Code用）

このファイルはどのClaude Codeセッション（デスクトップ・ターミナル・リモート・クラウド）でも
最初に読まれる前提の引き継ぎ書。**変更を本番反映したら、このファイルの「現在の状態」も更新すること。**

## このプロジェクトは何か

レース中継の**東京スイッチャー ⇄ 現地実況**のカンペ共有Webアプリ「KIPzKanvas」。
- 本番URL: **https://kipz-kanvas-45fa6.web.app**（Firebase Hosting）
- GitHub: https://github.com/kazuki-soundseek/KIPzKanvas
- Firebaseプロジェクト: `kipz-kanvas-45fa6`（所有: k.soundseek@gmail.com ／ Realtime Database: asia-southeast1）
- 部屋コード方式（部屋コードが実質の鍵。DBルールは rooms/ 以下のみ読み書き可）

## 機能一覧（2026-08-03時点）

- 東京側: 定型指示ボタン（==囲み==でマーカー）／自由入力（選択して🖊マーカー、送信済みも「マーカー編集」で書き換え可）／画像送信（自動で長辺1400px圧縮）／手書き（ペン小中大・蛍光マーカー、テキスト・写真を下地にできる）／URL送信／カウントダウン（構え1秒＋各1秒＋GO、タイムバー付き）／📣呼び出し（現場が赤枠点滅＋音＋バイブ4秒）／取消・再送・履歴全消去／定型ボタン編集（全員同期）
- 現地側: 全画面カンペ（文字自動最大化）／👍OK・✋できないスタンプ／1つ前バー（タップで履歴）／東京へのメッセージ入力欄（大画面は乗っ取らない）／💾画像保存／全画面ボタン／文字大・文字小／🔔切替
- 共通: 在席表示（未接続警告・切断で灰色化）／再接続バナー／スリープ防止

## 技術構成

- 素のHTML/CSS/JS（ビルド無し）。ホワイトテーマ。フォントは端末内蔵のみ（現場回線対策）
- `js/store.js` 状態とop（cue/ack/countdown/call/presets…）／`js/transport.js` 通信（firebase-config.jsが設定済みならFirebase、nullならdev-server.jsのSSE）／`js/app.js` 画面全部
- 画像はDBの `rooms/<room>/images/` に別置き（状態の監視は `rooms/<room>/state` のみ）
- ユーザー由来の文字列は必ず textContent / DOM API で描画（innerHTML禁止・XSS対策済み）

## 変更→本番反映の手順（重要）

1. コード修正
2. **js/css を変えたら index.html の `?v=N` を全て+1する**（旧キャッシュ対策。忘れると端末に反映されない）
3. ローカル確認: `node dev-server.js` → http://localhost:8790 （ポート8788は使用中のため避ける）
4. デプロイ: `firebase deploy --only hosting --project kipz-kanvas-45fa6 --non-interactive`
5. GitHub反映: `git add -A; git commit -m "日本語で内容" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"; git push`
6. テストで部屋を作ったら最後にDBから削除する（REST DELETE `.../rooms/<room>.json`）

## 飼い主（川口さん）の流儀

- 報告は**普通の日本語**で。「何を司る物がどうなったか→使う人にどう見えるか→実害」の順。関数名の羅列は禁止
- 判断を仰ぐときは推奨を先頭に、選ぶと何が変わるかを書く
- 検証は「何をどう確かめたか」を具体的に。未確認事項は未確認と明記
- 音・バイブ・書き味など実機でしか確認できない項目は、その旨を伝えて実機確認を依頼する

## 運用メモ

- 本番の部屋コードは推測されにくく（例: kipz-0809-xR7）。機密は書かない・映さない
- 番組ごとに新しい部屋コード推奨（履歴が混ざらない）
- iPhone Safariのみ全画面ボタン非対応（ホーム画面追加で代替）
