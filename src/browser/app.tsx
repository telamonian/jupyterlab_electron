// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
    JSONObject
} from '@phosphor/coreutils';

import {
    PageConfig
} from '@jupyterlab/coreutils';

import {
    StateDB
} from '@jupyterlab/coreutils';

import {
    asyncRemoteRenderer
} from '../asyncremote';

import {
    IServerFactory
} from '../main/server';

import {
    ISessions
} from '../main/sessions';

import {
    SplashScreen, ServerManager, TitleBar, ServerError
} from './components';

import {
    ElectronJupyterLab
} from './extensions/electron-extension';

import {
    JupyterServer
} from './utils';

import {
    JupyterLabSession
} from '../main/sessions';

import {
    remote, ipcRenderer
} from 'electron';

import * as React from 'react';
import extensions from './extensions';


export
class Application extends React.Component<Application.Props, Application.State> {

    constructor(props: Application.Props) {
        super(props);
        this._setLabDir();
        this._preventDefaults();
        this._renderServerManager = this._renderServerManager.bind(this);
        this._renderSplash = this._renderSplash.bind(this);
        this._renderEmpty = this._renderEmpty.bind(this);
        this._renderErrorScreen = this._renderErrorScreen.bind(this);
        this._connectionAdded = this._connectionAdded.bind(this);
        this._launchFromPath = this._launchFromPath.bind(this);
        this._labReady = this._setupLab();
        
        if (this.props.options.serverState == 'local') {
            this.state = {renderSplash: this._renderSplash, renderState: this._renderEmpty, remotes: []};
            asyncRemoteRenderer.runRemoteMethod(IServerFactory.requestServerStart, undefined)
                .then((data) => {
                    this._serverReady(data);
                })
        } else {
            this.state = {renderSplash: this._renderEmpty, renderState: this._renderServerManager, remotes: []};
        }
        
        this._serverState = new StateDB({namespace: Application.STATE_NAMESPACE});
        this._serverState.fetch(Application.SERVER_STATE_ID)
            .then((data: Application.IRemoteServerState | null) => {
                if (!data || !data.remotes)
                    return;
                // Find max connection ID
                let maxID = 0;
                for (let val of data.remotes) {
                    // Check validity of server state
                    if (!val.id || val.id < this._nextRemoteId || !JupyterServer.verifyServer(val))
                        continue;
                    maxID = Math.max(maxID, val.id);
                }
                this._nextRemoteId = maxID + 1;
                // Render UI with saved servers
                this.setState({remotes: data.remotes});
            })
            .catch((e) => {
                console.log(e);
            });
    }
    
    render() {
        let splash = this.state.renderSplash();
        let content = this.state.renderState();

        return (
            <div className='jpe-body'>
                {splash}
                {content}
            </div>
        );
    }

    private _serverReady(data: IServerFactory.IServerStarted): void {
        if (data.err) {
            console.error(data.err);
            this.setState({renderState: this._renderErrorScreen});
            (this.refs.splash as SplashScreen).fadeSplashScreen();
            return;
        }
        this._registerFileHandler();
        window.addEventListener('beforeunload', () => {
            asyncRemoteRenderer.runRemoteMethod(IServerFactory.requestServerStop, {
                factoryId: data.factoryId
            });
        });
        
        this._server = {
            token: data.token,
            url: data.url,
            name: 'Local',
            type: 'local',
        };

        PageConfig.setOption("token", this._server.token);
        PageConfig.setOption("baseUrl", this._server.url);
        
        this._labReady.then(() => {
            try {
                this._lab.start({"ignorePlugins": this._ignorePlugins});
            } catch(e) {
                console.log(e);
            }
            this._lab.restored.then( () => {
                ipcRenderer.send('lab-ready');
                (this.refs.splash as SplashScreen).fadeSplashScreen();
            });
        });
    }
    
    private _launchFromPath() {
        asyncRemoteRenderer.runRemoteMethod(IServerFactory.requestServerStartPath, undefined)
            .then((data: IServerFactory.IServerStarted) => {
                this._serverReady(data);
            });

        let pathSelected = () => {
            asyncRemoteRenderer.removeRemoteListener(IServerFactory.pathSelectedEvent, pathSelected);
            this.setState({renderSplash: this._renderSplash, renderState: this._renderEmpty});
        }
        asyncRemoteRenderer.onRemoteEvent(IServerFactory.pathSelectedEvent, pathSelected);
    }

    private _saveState() {
        this._serverState.save(Application.SERVER_STATE_ID, {remotes: this.state.remotes});
    }

    private _setupLab(): Promise<void> {
        return new Promise<void>((res, rej) => {
            let version : string = PageConfig.getOption('appVersion') || 'unknown';
            let name : string = PageConfig.getOption('appName') || 'JupyterLab';
            let namespace : string = PageConfig.getOption('appNamespace') || 'jupyterlab';
            let devMode : string  = PageConfig.getOption('devMode') || 'false';
            let settingsDir : string = PageConfig.getOption('settingsDir') || '';
            let assetsDir : string = PageConfig.getOption('assetsDir') || '';

            if (this.props.options.platform == 'win32')
                PageConfig.setOption('terminalsAvailable', 'false');

            if (version[0] === 'v') {
                version = version.slice(1);
            }

            this._lab = new ElectronJupyterLab({
                namespace: namespace,
                name: name,
                version: version,
                devMode: devMode.toLowerCase() === 'true',
                settingsDir: settingsDir,
                assetsDir: assetsDir,
                mimeExtensions: extensions.mime,
                platform: this.props.options.platform,
                uiState: this.props.options.uiState
            });

            try {
                this._lab.registerPluginModules(extensions.jupyterlab);
            } catch (e) {
                console.error(e);
            }
            
            res();
        });
    }

    private _connectionAdded(server: JupyterServer.IServer) {
        PageConfig.setOption('baseUrl', server.url);
        PageConfig.setOption('token', server.token);
        
        this._labReady.then(() => {
            try {
                this._lab.start({"ignorePlugins": this._ignorePlugins});
            } catch(e) {
                console.log(e);
            }
        });

        let rServer: Application.IRemoteServer = {...server, id: this._nextRemoteId++};
        this.setState((prev: ServerManager.State) => {
            server.id = this._nextRemoteId++;
            let conns = this.state.remotes.concat(rServer);
            this._saveState();
            return({
                renderState: this._renderEmpty,
                conns: {servers: conns}
            });
        });
    }

    private _renderServerManager(): JSX.Element {
        return (
            <div className='jpe-content'>
                <TitleBar uiState={this.props.options.uiState} />
                <ServerManager serverAdded={this._connectionAdded} />;
            </div>
        );
    }

    private _renderSplash(): JSX.Element {
        return (
            <div className='jpe-content'>
                <SplashScreen  ref='splash' uiState={this.props.options.uiState} finished={() => {
                    this.setState({renderSplash: this._renderEmpty});}
                } />
            </div>
        );
    }

    private _renderErrorScreen(): JSX.Element {
        return (
            <div className='jpe-content'>
                <TitleBar uiState={this.props.options.uiState} />
                <ServerError launchFromPath={this._launchFromPath}/>
            </div>
        )
    }

    private _renderEmpty(): JSX.Element {
        return null;
    }

    private _preventDefaults(): void {
        document.ondragover = (event: DragEvent) => {
            event.preventDefault();
        };
        document.ondragleave = (event: DragEvent) => {
            event.preventDefault();
        };
        document.ondragend = (event: DragEvent) => {
            event.preventDefault();
        };
        document.ondrop = (event: DragEvent) => {
            event.preventDefault();
        };
    }

    private _registerFileHandler(): void {
        document.ondrop = (event: DragEvent) => {
            event.preventDefault();
            let files = event.dataTransfer.files;
            for (let i = 0; i < files.length; i ++){
                this._openFile(files[i].path);
            }
        };

        asyncRemoteRenderer.onRemoteEvent(ISessions.openFileEvent, this._openFile);
    }

    private _openFile(path: string){
        if (this._labDir){
            let relPath = path.replace(this._labDir, '');
            let winConvert = relPath.split('\\').join('/');
            relPath = winConvert.replace("/", "");
            this._lab.commands.execute('docmanager:open', {path: relPath});
        }
    }

    private _setLabDir(){
        this._labDir = remote.app.getPath('home');
    }

    private _labDir: string;

    private _lab: ElectronJupyterLab;

    private _ignorePlugins: string[] = ['jupyter.extensions.server-manager'];

    private _server: JupyterServer.IServer = null;

    private _nextRemoteId: number = 1;
    
    private _serverState: StateDB;

    private _labReady: Promise<void>;
}

export 
namespace Application {
    
    /**
     * Namspace for server manager state stored in StateDB
     */
    export
    const STATE_NAMESPACE =  'JupyterApplication-state';

    /**
     * ID for ServerManager server data in StateDB
     */
    export
    const SERVER_STATE_ID = 'servers';

    export
    interface Props {
        options: JupyterLabSession.IInfo;
    }

    export
    interface State {
        renderState: () => any;
        renderSplash: () => any;
        remotes: IRemoteServer[];
    }

    export
    interface IRemoteServer extends JupyterServer.IServer {
        id: number;
    }

    export
    interface IRemoteServerState extends JSONObject {
        remotes: IRemoteServer[];
    }
}
