import React, { useState, KeyboardEvent } from 'react';
import { Input, Button, Space } from 'antd';
import { SendOutlined, StopOutlined } from '@ant-design/icons';

const { TextArea } = Input;

interface UserInputProps {
  onSubmit: (value: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  isRunning?: boolean;
}

export const UserInput: React.FC<UserInputProps> = ({
  onSubmit,
  onStop,
  disabled,
  isRunning,
}) => {
  const [value, setValue] = useState('');

  const handleSubmit = () => {
    if (value.trim() && !disabled) {
      onSubmit(value.trim());
      setValue('');
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="border-t bg-white p-4">
      <Space.Compact className="w-full">
        <TextArea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入你的需求... (Enter 发送, Shift+Enter 换行)"
          autoSize={{ minRows: 1, maxRows: 4 }}
          disabled={disabled}
          className="flex-1"
        />
        {isRunning ? (
          <Button
            danger
            icon={<StopOutlined />}
            onClick={onStop}
            className="h-auto px-4"
          >
            Stop
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSubmit}
            disabled={!value.trim() || disabled}
            className="h-auto px-4"
          >
            Send
          </Button>
        )}
      </Space.Compact>
      <div className="text-xs text-gray-400 mt-2 text-center">
        输入自然语言指令，如："帮我把背景颜色改成蓝色"
      </div>
    </div>
  );
};
