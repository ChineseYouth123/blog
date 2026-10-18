#!/bin/bash

# 遇到错误立即停止执行
set -e

# 获取当前脚本所在绝对路径，并定位到子仓库根目录
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
# 如果你把脚本放在 src/blog/脚本 下，这里就是 src/blog
cd "$SCRIPT_DIR/.."

# 防呆检查：确保当前确实是 Git 仓库（兼容 .git 文件和文件夹）
if [ ! -e ".git" ]; then
    echo "❌ 错误: 当前目录不是 Git 仓库！当前路径: $(pwd)"
    exit 1
fi

# ================= 功能函数 =================

# 1. 提交文档
do_commit() {
    echo ""
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
        return
    fi

    echo "🚀 开始执行..."
    if [ -z "$(git status --porcelain)" ]; then
        echo "ℹ️  仓库没有文件变更，无需提交。"
    else
        git add .
        git commit -m "$MSG"
        git push origin main
        echo "✅ 推送成功！"
        echo "⚠️  请记得回到主目录执行 ./scripts/push-docs.sh 更新主仓库指针！"
    fi
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
    echo "⚠️  你选择了【撤回上一次提交】。"
    echo "此操作会直接抹除最近一次提交，并将文件恢复到提交前的状态。"
    read -p "确认要撤回吗？(y/N) " CONFIRM
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo "❌ 已取消。"
        return
    fi

    echo "🚀 执行中..."
    # 强制回退到上一个版本
    git reset --hard HEAD~1
    # 强制推送到远程覆盖
    git push origin main --force
    echo "✅ 撤回成功！文件已恢复，且未产生新的 commit。"
}

# 4. 撤回特定提交（强制重置版）
do_revert_specific() {
    echo ""
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
    echo "  5. 退出"
    echo "=========================================="

    read -p "请选择操作 (1-5): " CHOICE

    case $CHOICE in
        1) do_commit ;;
        2) do_view_log ;;
        3) do_revert_last ;;
        4) do_revert_specific ;;
        5) echo "👋 再见！"; exit 0 ;;
        *) echo "❌ 无效的选项，请重新选择。" ;;
    esac
done
