#!/usr/bin/env python3
"""
飞书长连接测试 - 等待用户发送消息给机器人
"""

import json
import sys
from pathlib import Path

def get_config_path():
    config_dir = Path.home() / "Library" / "Application Support" / "com.claude.monitor"
    return config_dir / "config.json"

def load_config():
    with open(get_config_path()) as f:
        return json.load(f)

def main():
    import lark_oapi as lark
    from lark_oapi.event.callback.model.p2_card_action_trigger import (
        P2CardActionTrigger,
        P2CardActionTriggerResponse,
    )
    
    config = load_config()
    app_id = config.get("app_id", "")
    app_secret = config.get("app_secret", "")
    
    def do_message_receive(data: lark.im.v1.P2ImMessageReceiveV1) -> None:
        """接收消息"""
        msg_type = data.event.message.message_type
        content = data.event.message.content
        sender = data.event.sender.sender_id.open_id
        
        print(f"\n{'='*50}")
        print(f"📥 收到消息!")
        print(f"   发送者: {sender}")
        print(f"   类型: {msg_type}")
        print(f"   内容: {content}")
        print(f"{'='*50}\n")
    
    def do_card_action_trigger(data: P2CardActionTrigger) -> P2CardActionTriggerResponse:
        """处理卡片按钮点击"""
        try:
            action_value = data.event.action.value
            user_name = data.event.operator.nickname
            
            print(f"\n{'='*50}")
            print(f"🔘 收到卡片回调!")
            print(f"   用户: {user_name}")
            print(f"   选择: {action_value.get('choice', '未知')}")
            print(f"   完整数据: {json.dumps(dict(action_value), ensure_ascii=False)}")
            print(f"{'='*50}\n")
            
            # 保存用户选择
            choice_path = get_config_path().parent / "user_choice.txt"
            with open(choice_path, "w") as f:
                f.write(action_value.get("choice", ""))
            print(f"✅ 已保存到: {choice_path}")
            
        except Exception as e:
            print(f"❌ 处理失败: {e}")
        
        return P2CardActionTriggerResponse({
            "toast": {"type": "success", "content": "回调成功！"}
        })
    
    # 创建事件处理器
    event_handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(do_message_receive)
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
    
    print("="*50)
    print("飞书长连接测试")
    print("="*50)
    print(f"\nApp ID: {app_id}")
    print("\n请执行以下步骤:")
    print("1. 打开飞书")
    print("2. 搜索你的机器人名称")
    print("3. 发送消息给机器人")
    print("4. 观察此窗口是否收到消息")
    print("\n按 Ctrl+C 退出...\n")
    
    cli.start()

if __name__ == "__main__":
    main()
