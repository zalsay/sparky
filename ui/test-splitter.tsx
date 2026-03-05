import { Splitter } from 'antd';
const Test = () => {
    return (
        <Splitter onResize={(sizes) => console.log(sizes)}>
            <Splitter.Panel size={100} defaultSize="50%" />
        </Splitter>
    );
};
