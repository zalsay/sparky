#!/usr/bin/env python3
"""
飞书长连接客户端
使用官方 SDK 建立 WebSocket 长连接，接收事件并处理卡片回调
"""

import asyncio
import json
import os
import sys
import threading
from pathlib import Path

# 配置文件路径
def get_config_path():
    config_dir = Path.home() / "Library" / "Application Support" / "com.claude.monitor"
    if sys.platform == "win32":
        config_dir = Path(os.environ.get("APPDATA", "")) / "com.claude.monitor"
    elif sys.platform == "linux":
        config_dir = Path.home() / ".config" / "com.claude.monitor"
    return config_dir / "config.json"

def load_config():
    config_path = get_config_path()
    if not config_path.exists():
        print(f"配置文件不存在: {config_path}")
        sys.exit(1)
    
    with open(config_path, "r") as f:
        return json.load(f)

def save_user_choice(choice: str):
    """保存用户选择到文件"""
    config_dir = get_config_path().parent
    choice_path = config_dir / "user_choice.txt"
    with open(choice_path, "w") as f:
        f.write(choice)
    print(f"[INFO] 用户选择已保存: {choice}")

# 主程序
def main():
    try:
        import lark_oapi as lark
        from lark_oapi.event.callback.model.p2_card_action_trigger import (
            P2CardActionTrigger,
            P2CardActionTriggerResponse,
        )
    except ImportError:
        print("[ERROR] 请安装飞书 SDK: pip install lark-oapi")
        print("[ERROR] 如果遇到 Crypto 模块错误，请安装: pip install pycryptodome")
        sys.exit(1)

    config = load_config()
    app_id = config.get("app_id", "")
    app_secret = config.get("app_secret", "")

    if not app_id or not app_secret:
        print("[ERROR] 配置中缺少 app_id 或 app_secret")
        sys.exit(1)

    print(f"[INFO] App ID: {app_id}")
    print("[INFO] 正在连接飞书长连接服务...")

    def do_p2_im_message_receive_v1(data: lark.im.v1.P2ImMessageReceiveV1) -> None:
        print(f"[INFO] 收到消息: {data.event.message.content}")

    def do_card_action_trigger(data: P2CardActionTrigger) -> P2CardActionTriggerResponse:
        """处理卡片按钮点击"""
        try:
            event_data = json.loads(lark.JSON.marshal(data))
            print(f"[INFO] 收到卡片回调: {json.dumps(event_data, indent=2, ensure_ascii=False)}")
            
            # 获取用户选择的值
            action_value = data.event.action.value
            if action_value:
                choice = action_value.get("choice", "")
                if choice:
                    print(f"[INFO] 用户选择: {choice}")
                    save_user_choice(choice)
            
            # 返回 toast 提示
            resp = {
                "toast": {
                    "type": "info",
                    "content": f"已收到您的选择: {action_value.get('choice', '未知')}"
                }
            }
            return P2CardActionTriggerResponse(resp)
        except Exception as e:
            print(f"[ERROR] 处理卡片回调失败: {e}")
            return P2CardActionTriggerResponse({})

    # 创建事件处理器
    event_handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(do_p2_im_message_receive_v1)
        .register_p2_card_action_trigger(do_card_action_trigger)
        .build()
    )

    # 创建 WebSocket 客户端
    cli = lark.ws.Client(
        app_id,
        app_secret,
        event_handler=event_handler,
        log_level=lark.LogLevel.DEBUG,
    )

    print("[INFO] 长连接服务已启动，按 Ctrl+C 退出")
    print("[INFO] 等待飞书事件...")

    try:
        cli.start()
    except KeyboardInterrupt:
        print("\n[INFO] 正在关闭长连接服务...")
    except Exception as e:
        print(f"[ERROR] 长连接错误: {e}")
        raise

if __name__ == "__main__":
    main()
