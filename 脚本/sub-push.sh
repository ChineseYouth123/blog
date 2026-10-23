#!/bin/bash

# 遇到错误立即停止执行
set -e

# 获取当前脚本所在绝对路径，并定位到子仓库根目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cd "$SCRIPT_DIR/.."

# 防呆检查：确保当前确实是 Git 仓库
if [ ! -e ".git" ]; then
    echo "❌ 错误: 当前目录不是 Git 仓库！当前路径: $(pwd)"
    exit 1
fi

# ================= 功能函数 =================

# 0. 手动更新代码
do_update() {
    echo ""
    echo "🔄 正在从远程拉取最新代码 (git pull --rebase)..."
    if git pull --rebase origin main; then
        echo "✅ 代码更新成功！"
    else
        echo "❌ 更新失败，可能存在冲突。请手动在终端解决冲突后执行 git rebase --continue"
    fi
    read -p "按回车键返回主菜单..."
}

# 1. 提交文档（支持选择部分文件，不影响未选中的文件）
do_commit() {
    echo ""
    echo "🔄 提交前自动检查远程更新..."
    git pull --rebase origin main > /dev/null 2>&1 || true

    # ---- 检查是否有变更 ----
    if [ -z "$(git status --porcelain)" ]; then
        echo "ℹ️  仓库没有文件变更，无需提交。"
        read -p "按回车键返回主菜单..."
        return
    fi

    # ---- 显示变更列表 ----
    echo ""
    echo "📂 当前有变更的文件："
    echo "------------------------------------------"
    git status --short
    echo "------------------------------------------"

    # ---- 让用户选择要提交的文件 ----
    echo ""
    echo "请选择要提交的文件："
    echo "  1) 提交全部变更文件"
    echo "  2) 手动输入文件路径（支持多个，空格分隔）"
    echo "  3) 取消提交"
    read -p "请输入数字 (1-3): " FILE_CHOICE

    case $FILE_CHOICE in
        1)
            git add .
            echo "✅ 已暂存全部变更文件。"
            ;;
        2)
            read -p "请输入要提交的文件路径（多个用空格分隔，例如: docs/a.md docs/b.md）: " FILES
            if [ -z "$FILES" ]; then
                echo "❌ 未输入文件路径，已取消。"
                read -p "按回车键返回主菜单..."
                return
            fi
            # 校验文件是否存在于变更列表中
            INVALID=""
            for f in $FILES; do
                if ! git status --porcelain | grep -q "$f"; then
                    INVALID="$INVALID $f"
                fi
            done
            if [ -n "$INVALID" ]; then
                echo "⚠️  以下文件不在变更列表中，将被忽略:$INVALID"
            fi
            git add $FILES
            echo "✅ 已暂存指定的文件。"
            ;;
        *)
            echo "❌ 已取消提交。"
            read -p "按回车键返回主菜单..."
            return
            ;;
    esac

    # ---- 检查暂存区是否真的有内容 ----
    if [ -z "$(git diff --cached --name-only)" ]; then
        echo "ℹ️  暂存区为空，没有文件可提交。"
        read -p "按回车键返回主菜单..."
        return
    fi

    echo ""
    echo "📋 本次将要提交的文件："
    git diff --cached --name-only
    echo ""

    # ---- 选择提交类型 ----
    echo "请选择本次提交的类型："
    PS3="请输入数字 (1-5): "
    select TYPE in "新增内容 (feat)" "修改文档 (docs)" "修复错误 (fix)" "排版美化 (style)" "其他 (chore)"; do
        if [ -n "$TYPE" ]; then
            PREFIX=$(echo "$TYPE" | grep -oP '(?<=\()[^)]+' || echo "docs")
            break
        else
            echo "❌ 无效的选择。"
        fi
    done

    # ---- 输入修改说明 ----
    while true; do
        read -p "请输入具体的修改说明（不能为空）: " DESC
        [ -n "$DESC" ] && break
        echo "❌ 说明不能为空！"
    done

    MSG="$PREFIX: $DESC"
    echo ""
    echo "📋 准备提交的信息: $MSG"
    read -p "确认要提交并推送吗？(Y/n) " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]] && [ -n "$CONFIRM" ]; then
        echo "❌ 已取消。"
        read -p "按回车键返回主菜单..."
        return
    fi

    # ---- 提交并推送 ----
    echo "🚀 开始执行..."
    git commit -m "$MSG"
    git push origin main
    echo "✅ 推送成功！"
    echo "⚠️  请记得回到主目录执行 ./scripts/push-docs.sh 更新主仓库指针！"
    echo ""
    echo "ℹ️  未选中的文件仍保留在工作区，状态未变，可下次单独提交。"
    read -p "按回车键返回主菜单..."
}

# 2. 查看提交记录
do_view_log() {
    echo ""
    echo "================ 仓库最近 15 次提交 ================"
    git log --oneline -15 --color=always
    echo ""
    read -p "按回车键返回主菜单..."
}

# 3. 撤回上一次提交（强制重置版）
do_revert_last() {
    echo ""
    echo "🔄 撤回前先同步远程状态..."
    git fetch origin main > /dev/null 2>&1 || true

    echo "⚠️  你选择了【撤回上一次提交】。"
    echo "此操作会直接抹除最近一次提交，并将文件恢复到提交前的状态。"
    read -p "确认要撤回吗？(y/N) " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo "❌ 已取消。"
        return
    fi

    echo "🚀 执行中..."
    git reset --hard HEAD~1
    git push origin main --force
    echo "✅ 撤回成功！文件已恢复，且未产生新的 commit。"
    read -p "按回车键返回主菜单..."
}

# 4. 撤回特定提交（强制重置版）
do_revert_specific() {
    echo ""
    echo "🔄 撤回前先同步远程状态..."
    git fetch origin main > /dev/null 2>&1 || true

    git log --oneline -15 --color=always
    read -p "请输入你想撤回的 commit hash (前7位即可): " COMMIT_HASH

    if [ -z "$COMMIT_HASH" ]; then
        echo "❌ 未输入哈希，已取消。"
        return
    fi

    echo "⚠️  你选择了直接重置到提交: $COMMIT_HASH"
    echo "此操作会抹除该提交之后的所有历史，并将文件恢复到该提交的状态！"
    read -p "确认继续吗？(y/N) " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo "❌ 已取消。"
        return
    fi

    echo "🚀 执行中..."
    git reset --hard "$COMMIT_HASH"
    git push origin main --force
    echo "✅ 已成功重置到该提交，后续记录已抹除。"
    read -p "按回车键返回主菜单..."
}

# 5. 运行同级目录下的 geshihua.js (新增功能)
do_format() {
    echo ""
    # 获取脚本所在目录
    LOCAL_SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
    
    # 检查有没有 node 环境
    if ! command -v node &> /dev/null; then
        echo "❌ 错误: 未找到 Node.js！请先安装 Node.js。"
        read -p "按回车键返回主菜单..."
        return
    fi

    # 检查 js 文件是否存在
    JS_FILE="$LOCAL_SCRIPT_DIR/脚本/geshihua.js"
    if [ ! -f "$JS_FILE" ]; then
        echo "❌ 错误: 找不到 $JS_FILE 文件，请检查路径！"
        read -p "按回车键返回主菜单..."
        return
    fi

    echo "▶ 正在执行 geshihua.js 格式化文档..."
    echo "------------------------------------------"
    # 调用 node 执行这个 js 文件
    if node "$JS_FILE"; then
        echo "------------------------------------------"
        echo "✅ 格式化执行完毕！"
    else
        echo "------------------------------------------"
        echo "❌ 格式化执行失败，请检查 geshihua.js 的代码逻辑。"
    fi
    read -p "按回车键返回主菜单..."
}

# ================= 主菜单循环 =================

while true; do
    echo ""
    echo "=========================================="
    echo "      📝 文档子仓库独立管理工具"
    echo "=========================================="
    echo "  1. 提交文档 (自动带前缀)"
    echo "  2. 查看提交记录"
    echo "  3. 撤回上一次提交 (彻底回退)"
    echo "  4. 撤回特定提交 (彻底回退)"
    echo "  5. 手动从远程更新 (git pull)"
    echo "  6. 运行 geshihua.js (格式化)"
    echo "  7. 退出"
    echo "=========================================="

    read -p "请选择操作 (1-7): " CHOICE

    case $CHOICE in
        1) do_commit ;;
        2) do_view_log ;;
        3) do_revert_last ;;
        4) do_revert_specific ;;
        5) do_update ;;
        6) do_format ;;
        7) echo "👋 再见！"; exit 0 ;;
        *) echo "❌ 无效的选项，请重新选择。" ;;
    esac
done