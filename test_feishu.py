#!/usr/bin/env python3
"""
飞书长连接测试脚本
测试消息发送和卡片回调接收
"""

import json
import sys
import threading
import time
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

def test_send_message():
    """测试发送消息"""
    import requests
    
    config = load_config()
    app_id = config.get("app_id", "")
    app_secret = config.get("app_secret", "")
    
    # 获取 tenant_access_token
    print("1. 获取 access_token...")
    token_url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
    resp = requests.post(token_url, json={
        "app_id": app_id,
        "app_secret": app_secret
    })
    token_data = resp.json()
    
    if token_data.get("code", 0) != 0:
        print(f"获取 token 失败: {token_data}")
        return
    
    token = token_data["tenant_access_token"]
    print(f"   Token: {token[:20]}...")
    
    # 获取机器人所在的群列表
    print("\n2. 获取机器人所在的群聊列表...")
    chats_url = "https://open.feishu.cn/open-apis/im/v1/chats?page_size=20"
    resp = requests.get(chats_url, headers={
        "Authorization": f"Bearer {token}"
    })
    chats_data = resp.json()
    
    if chats_data.get("code", 0) != 0:
        print(f"获取群聊失败: {chats_data}")
        return
    
    chats = chats_data.get("data", {}).get("items", [])
    if not chats:
        print("机器人还没有加入任何群聊，请先在飞书中创建群聊并添加机器人")
        return
    
    print(f"   找到 {len(chats)} 个群聊:")
    for i, chat in enumerate(chats):
        print(f"   [{i}] {chat.get('name', '未命名')} (chat_id: {chat.get('chat_id', '')})")
    
    # 选择第一个群聊发送测试消息
    chat_id = chats[0]["chat_id"]
    chat_name = chats[0].get("name", "未命名")
    print(f"\n3. 向群聊 [{chat_name}] 发送测试卡片消息...")
    
    # 发送交互式卡片
    card = {
        "msg_type": "interactive",
        "card": {
            "config": {"wide_screen_mode": True},
            "elements": [
                {
                    "tag": "div",
                    "text": {
                        "content": "🧪 **测试消息**\n\n这是一条测试消息，请点击下面的按钮测试卡片回调。",
                        "tag": "lark_md"
                    }
                },
                {
                    "tag": "action",
                    "actions": [
                        {
                            "tag": "button",
                            "text": {"content": "✅ 按钮 1", "tag": "plain_text"},
                            "type": "primary",
                            "value": {"choice": "1", "test_id": "test_001"}
                        },
                        {
                            "tag": "button",
                            "text": {"content": "❌ 按钮 2", "tag": "plain_text"},
                            "type": "danger",
                            "value": {"choice": "2", "test_id": "test_001"}
                        }
                    ]
                }
            ]
        }
    }
    
    send_url = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id"
    resp = requests.post(send_url, headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }, json={
        "receive_id": chat_id,
        "msg_type": "interactive",
        "content": json.dumps(card)
    })
    
    result = resp.json()
    if result.get("code", 0) == 0:
        print(f"   ✅ 消息发送成功！")
        print(f"\n4. 请在飞书群聊 [{chat_name}] 中点击按钮测试回调")
        print(f"   长连接服务将接收卡片回调事件...")
    else:
        print(f"   ❌ 消息发送失败: {result}")

def start_ws_client():
    """启动 WebSocket 长连接客户端"""
    import lark_oapi as lark
    from lark_oapi.event.callback.model.p2_card_action_trigger import (
        P2CardActionTrigger,
        P2CardActionTriggerResponse,
    )
    
    config = load_config()
    app_id = config.get("app_id", "")
    app_secret = config.get("app_secret", "")
    
    def do_card_action_trigger(data: P2CardActionTrigger) -> P2CardActionTriggerResponse:
        """处理卡片按钮点击"""
        try:
            event_data = json.loads(lark.JSON.marshal(data))
            action_value = data.event.action.value
            
            print("\n" + "="*50)
            print("📥 收到卡片回调!")
            print(f"   用户: {data.event.operator.nickname} ({data.event.operator.open_id})")
            print(f"   选择: {action_value.get('choice', '未知')}")
            print(f"   完整数据: {json.dumps(action_value, ensure_ascii=False)}")
            print("="*50 + "\n")
            
            # 保存用户选择
            choice_path = get_config_path().parent / "user_choice.txt"
            with open(choice_path, "w") as f:
                f.write(action_value.get("choice", ""))
            print(f"✅ 已保存用户选择到: {choice_path}")
            
        except Exception as e:
            print(f"❌ 处理卡片回调失败: {e}")
        
        return P2CardActionTriggerResponse({
            "toast": {"type": "success", "content": "回调测试成功！"}
        })
    
    # 创建事件处理器
    event_handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_card_action_trigger(do_card_action_trigger)
        .build()
    )
    
    # 创建 WebSocket 客户端
    cli = lark.ws.Client(
        app_id,
        app_secret,
        event_handler=event_handler,
        log_level=lark.LogLevel.INFO,
    )
    
    print("\n🔌 长连接服务已启动，等待回调...")
    cli.start()

def main():
    print("="*50)
    print("飞书长连接测试工具")
    print("="*50)
    
    # 启动 WebSocket 客户端（在新线程）
    ws_thread = threading.Thread(target=start_ws_client, daemon=True)
    ws_thread.start()
    
    # 等待连接建立
    time.sleep(3)
    
    # 发送测试消息
    test_send_message()
    
    # 保持运行
    print("\n按 Ctrl+C 退出...")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n退出测试")

if __name__ == "__main__":
    main()
