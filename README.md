# OnOffラウンジ 予定ビューア

Outlook が公開している ICS を **GitHub Actions で軽量JSONに変換**し、
**GitHub Pages** で表示する仕組みです。同じデータから2つの画面を出しています。

| ページ | 用途 | URL |
|---|---|---|
| スマホ用 | 月カレンダー。先の予定まで見る＋予約フォームへのボタン | `/` |
| サイネージ用 | ラウンジ入口の常時表示。今週・来週＋QR | `/signage.html` |

ICS は約 100KB（100件）ありますが、実際にブラウザが読むのは **初回 0.3KB 程度**です。

---

## セットアップ

### 1. リポジトリを作って push

```bash
gh repo create onoff-lounge-calendar --public --source=. --push
```

> ⚠️ ICSのURLはリポジトリに含めません（下の Secret に入れます）。
> URLが漏れると、伏せ字前の実名入りカレンダーを誰でも購読できてしまうためです。

### 2. ICSのURLを Secret に登録

```bash
gh secret set ICS_URL --body "https://outlook.office365.com/owa/calendar/.../calendar.ics"
```

（Web からなら Settings → Secrets and variables → Actions → New repository secret、
名前は `ICS_URL`）

### 3. Pages を有効化

Settings → Pages → **Source: GitHub Actions** を選択。

### 4. 初回実行

Actions タブ → 「Update calendar」 → Run workflow。
完了すると `https://<ユーザー名>.github.io/onoff-lounge-calendar/` で見られます。

以降は **30分おきに自動更新**されます。

---

## 軽量化の中身

| 手法 | 効果 |
|---|---|
| ICSのパースをActions側でやる | ブラウザは100KBのICSもパーサも読まない |
| `DESCRIPTION` / `X-MICROSOFT-*` / `UID` / `DTSTAMP` を捨てる | ICSの容量の大半がここ |
| 過去31日より前を切り捨て | 蓄積しても重くならない（ここが一番効きます） |
| 月別ファイルに分割 | 表示中の月しか取りに行かない |
| タイトル・場所を文字列テーブル化＋予定を配列タプル化 | JSONのキー名の重複が消える |
| 時刻を「0時からの分」の整数に | `"18:00"`(7B) → `1080`(4B) |
| 連続コマの同一予定を結合 | 学園祭の7コマ連続予約 → 1ブロック |
| `index.json` のバージョンで localStorage キャッシュ | 変更がなければ月データは再取得しない |
| 隣の月をアイドル時に先読み | 月送りが待ち時間ゼロ |

実測: **97.8KB → 0.8KB（99.2%減）**、初回表示に必要なのは index + 当月で **0.3KB**。

予定が増えても、切り捨て窓と月分割があるので**1か月分（数KB）以上には成長しません**。

---

## サイネージ（`/signage.html`）

ラウンジ入口のディスプレイに出しっぱなしにする前提の画面です。**操作は一切不要**。
明るい入口に置く前提で**ライトモード**にしています。

上から順に、優先度の高いものを大きく置いています。

1. **ただいまの状態** — 「貸切中（〇〇／19:30 まで）」か「自由に使えます（次の貸切は 13:00 から）」
2. **今週の予定** — 主役。1日1枚のカードで大きく
3. **来週** — おまけ。今週と同じ形式（イベント名＋時間）で、行を低く小さく
4. **QRコード** — 予約フォームとスマホ用ページ

画面の縦横比で自動的にレイアウトが切り替わります。

| 設置 | 今週の並べ方 | QRの位置 |
|---|---|---|
| **縦置き（ワイドパネルを縦向きに）** | 1日1行を縦に7本 | 下端に横並び |
| 横長（16:9そのまま） | 7列のカード | 右側に縦並び |

1日に予定が多い日は時刻を優先して残し、名前側だけを省略して「ほか◯件」を出します。

### 出しっぱなしにするための仕組み

| 動作 | 間隔 |
|---|---|
| 時計・「ただいま」表示の更新 | 15秒 |
| `index.json` を見て更新の有無を確認 | 5分 |
| 日付が変わったら週を自動で送る | 15秒ごとに判定 |
| ページ自体を再読込（コード更新の取り込み） | 24時間 |
| 焼き付き防止に表示位置を数px動かす | 7分 |

通信が切れても直前の内容を出し続け、30分以上更新できないときだけ右下に警告を出します。

### 表示端末の設定

Chrome をキオスクモードで自動起動させるのが手軽です。

```bash
chromium --kiosk --noerrdialogs --disable-infobars --incognito https://chiemi627.github.io/onoff-lounge-calendar/signage.html
```

ディスプレイのスリープ／スクリーンセーバーは切っておいてください。

### QRコード

`docs/qr-*.svg` は依存パッケージなしの自前エンコーダ（`scripts/qr.mjs`）で生成した静的ファイルです。
URLを変えたい場合は `scripts/make-qr.mjs` の `TARGETS` を編集して再生成します。

> 予約フォームのURLは3か所にあります。変更するときは全部直してください。
> `scripts/make-qr.mjs`（QR用）、`docs/index.html`（スマホ版のボタン）、
> そして再生成した `docs/qr-form.svg`。

---

## 予約の変更・取消

自動キャンセルの仕組みは入れていません。件数が少ないため人手で対応する方針です。
両方のページに「予約の変更・取消は渡辺までご連絡ください」の案内を常時表示しています。

表記を変えるときは次の2か所（どちらもコメント付き）を直してください。

| ファイル | 場所 |
|---|---|
| `docs/index.html` | `<p class="note">` — スマホ版フッター |
| `docs/signage.html` | `<p class="rail-note">` — サイネージのQR下 |

なお **Jicoo 経由の予約は Outlook から消しても Jicoo 側の枠が空きません**。
Jicoo で入った予約（予定の詳細に `jicoo.com` のリンクがあるもの）は
Jicoo 側でキャンセルしてください。

```bash
node scripts/make-qr.mjs
```

---

## 個人名の扱い

`scripts/config.mjs` で制御しています。

- `〈氏名〉 OnOffラウンジ予約` 形式（Jicoo経由の個人予約）→ **「予約済み」に置換**
- ただし `KEEP_IF_INCLUDES`（講義・見学・説明会 など）を含むものはイベント名として残す
- `ALWAYS_MASK` に正規表現を足せば個別に伏せられます
- `DESCRIPTION`（予約時のメッセージ本文）は**常に破棄**

ページには `noindex` を入れてあるので検索エンジンには載りません。
ただしURLを知っている人は誰でも見られます。

---

## ローカルで確認

```bash
ICS_URL="https://..." node scripts/build.mjs && (cd docs && python3 -m http.server 8000)
```

http://localhost:8000 を開く。

保存済みの `.ics` ファイルからも作れます:

```bash
node scripts/build.mjs path/to/calendar.ics
```

---

## よく触る設定 (`scripts/config.mjs`)

| 変数 | 既定 | 意味 |
|---|---|---|
| `PAST_DAYS` | 31 | 何日前まで残すか |
| `FUTURE_DAYS` | 400 | 何日先まで出すか |
| `MERGE_GAP_MIN` | 15 | 同一タイトルの予定を結合する隙間(分) |
| `SHOW_LOCATION` | false | 場所を表示するか |
| `MASKED_LABEL` | 予約済み | 伏せ字の表示 |

更新頻度は `.github/workflows/update.yml` の cron で調整します
（例: 日中だけなら `0 22-9 * * *`）。
