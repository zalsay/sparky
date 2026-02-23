.PHONY: clean build

build:
	@echo "构建当前系统版本应用..."
	@cargo build --release
	@cargo tauri build

clean:
	@echo "清理构建缓存..."
	@rm -rf src-tauri/target target ui/dist ui/.vite ui/node_modules/.vite ui/node_modules/.cache
	@echo "清理完成"
