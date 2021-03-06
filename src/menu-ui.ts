import AutoLaunch from 'auto-launch';
import { distanceInWords } from 'date-fns';
import {
  app,
  Menu,
  MenuItemConstructorOptions,
  Notification,
  shell,
  Tray
} from 'electron'; // tslint:disable-line no-implicit-dependencies
import settings from 'electron-settings';
import Connection from './connection';
import ICONS from './icons';
import Netlify, { NetlifyDeploy, NetlifySite, NetlifyUser } from './netlify';

interface JsonObject {
  [x: string]: JsonValue;
}

interface JsonArray extends Array<JsonValue> {} // tslint:disable-line no-empty-interface
type JsonValue = string | number | boolean | null | JsonArray | JsonObject;

interface AppSettings {
  launchAtStart: boolean;
  pollInterval: number;
  showNotifications: boolean;
  currentSiteId: string | null;
}

interface AppState {
  menuIsOpen: boolean;
  previousDeployState: string;
}

interface AppNetlifyData {
  deploys: NetlifyDeploy[];
  sites: NetlifySite[];
  user?: NetlifyUser;
}

const DEFAULT_SETTINGS: AppSettings = {
  currentSiteId: null,
  launchAtStart: false,
  pollInterval: 10000,
  showNotifications: false
};

export default class UI {
  private apiClient: Netlify;
  private autoLauncher: AutoLaunch;
  private connection: Connection;
  private state: AppState;
  private tray: Tray;
  private settings: AppSettings;
  private netlifyData: AppNetlifyData;

  public constructor({
    apiClient,
    autoLauncher,
    connection
  }: {
    apiClient: Netlify;
    autoLauncher: AutoLaunch;
    connection: Connection;
  }) {
    this.tray = new Tray(ICONS.loading);
    this.apiClient = apiClient;
    this.autoLauncher = autoLauncher;
    this.connection = connection;

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(settings.getAll() as {})
    };

    this.netlifyData = {
      deploys: [],
      sites: []
    };

    this.state = {
      menuIsOpen: false,
      previousDeployState: ''
    };

    this.setup().then(() => {
      const repeat = () => {
        setTimeout(async () => {
          await this.updateDeploys();
          repeat();
        }, this.settings.pollInterval);
      };

      repeat();
    });
  }

  private async setup(): Promise<void> {
    await this.fetchData(async () => {
      if (!this.settings.currentSiteId) {
        this.settings.currentSiteId = await this.getFallbackSiteId();
      }

      const [currentUser, sites, deploys] = await Promise.all([
        this.apiClient.getCurrentUser(),
        this.apiClient.getSites(),
        this.apiClient.getSiteDeploys(this.settings.currentSiteId)
      ]);

      this.netlifyData = {
        deploys,
        sites,
        user: {
          email: currentUser.email
        }
      };
    });
  }

  private getSite(siteId: string): NetlifySite {
    return (
      this.netlifyData.sites.find(
        ({ id }) => id === this.settings.currentSiteId
      ) || this.netlifyData.sites[0]
    );
  }

  private async getFallbackSiteId(): Promise<string> {
    const sites = await this.apiClient.getSites();
    return sites[0].id;
  }

  private getDeploysSubmenu(
    deploys: NetlifyDeploy[],
    currentSite: NetlifySite
  ): MenuItemConstructorOptions[] {
    return deploys
      .slice(0, 20)
      .map(({ context, created_at, state, branch, deploy_time, id }) => {
        return {
          click: () =>
            shell.openExternal(
              `https://app.netlify.com/sites/${currentSite.name}/deploys/${id}`
            ),
          label: `${context}: ${state} → ${branch} | ${distanceInWords(
            new Date(created_at),
            new Date()
          )} ago ${deploy_time ? `in ${deploy_time}s` : ''}`
        };
      });
  }

  private getSitesSubmenu(sites: NetlifySite[]): MenuItemConstructorOptions[] {
    return sites.map(
      ({ id, url }): MenuItemConstructorOptions => ({
        checked: this.settings.currentSiteId === id,
        click: async () => {
          this.saveSetting('currentSiteId', id);
          this.state.previousDeployState = '';
          this.updateDeploys();
        },
        label: `${url.replace(/https?:\/\//, '')}`,
        type: 'radio'
      })
    );
  }

  private getSettingsSubmenu(): MenuItemConstructorOptions[] {
    const { pollInterval, showNotifications, launchAtStart } = this.settings;
    const pollDurations = [
      { value: 10000, label: '10sec' },
      { value: 30000, label: '30sec' },
      { value: 60000, label: '1min' },
      { value: 180000, label: '3min' },
      { value: 300000, label: '5min' }
    ];

    return [
      {
        checked: launchAtStart,
        click: () => {
          this.saveSetting('launchAtStart', !launchAtStart);
          if (!launchAtStart) {
            this.autoLauncher.enable();
          } else {
            this.autoLauncher.disable();
          }
        },
        label: 'Launch at start',
        type: 'checkbox'
      },
      {
        checked: showNotifications,
        click: () => this.saveSetting('showNotifications', !showNotifications),
        label: 'Show notifications',
        type: 'checkbox'
      },
      {
        label: 'Poll interval',
        submenu: pollDurations.map(
          ({ label, value }): MenuItemConstructorOptions => ({
            checked: pollInterval === value,
            click: () => this.saveSetting('pollInterval', value),
            label,
            type: 'radio'
          })
        )
      }
    ];
  }

  private async fetchData(fn: () => void): Promise<void> {
    if (this.connection.isOnline) {
      this.tray.setImage(ICONS.loading);

      // catch possible network hickups
      try {
        await fn();
        this.setNewDeployState();
        this.tray.setImage(ICONS[this.state.previousDeployState]);
      } catch (e) {
        this.tray.setImage(ICONS.offline);
      }
    } else {
      this.tray.setImage(ICONS.offline);
    }

    this.render();
  }

  private updateDeploys(): Promise<void> {
    return this.fetchData(async () => {
      if (this.settings.currentSiteId) {
        this.netlifyData.deploys = await this.apiClient.getSiteDeploys(
          this.settings.currentSiteId
        );
      }
    });
  }

  private setNewDeployState(): void {
    const { deploys } = this.netlifyData;
    const deployState = deploys[0] ? deploys[0].state : '';

    const newDeployStateIsAvailable =
      this.state.previousDeployState &&
      this.state.previousDeployState !== deployState;

    if (this.settings.showNotifications && newDeployStateIsAvailable) {
      new Notification({
        body: `Last deploy in the queue switched to ${deployState}`,
        title: 'New deploy status'
      }).show();
    }

    this.state.previousDeployState = deployState;
  }

  private saveSetting(key: string, value: JsonValue): void {
    settings.set(key, value);
    this.settings[key] = value;
    this.render();
  }

  private async render(): Promise<void> {
    if (!this.settings.currentSiteId) {
      console.error('No current site id found'); // tslint:disable-line no-console
      return;
    }

    if (!this.connection.isOnline) {
      return this.tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            enabled: false,
            label: "Looks like you're offline..."
          }
        ])
      );
    }

    const { currentSiteId } = this.settings;
    const { sites, deploys, user } = this.netlifyData;

    const currentSite = this.getSite(currentSiteId);
    const menu = Menu.buildFromTemplate([
      {
        enabled: false,
        label: `Netlify Menubar ${app.getVersion()}`
      },
      { type: 'separator' },
      {
        enabled: false,
        label: user && user.email
      },
      { type: 'separator' },
      {
        label: 'Choose site:',
        submenu: this.getSitesSubmenu(sites)
      },
      { type: 'separator' },
      {
        enabled: false,
        label: `${currentSite.url.replace(/https?:\/\//, '')}`
      },
      {
        click: () => shell.openExternal(currentSite.url),
        label: 'Go to Site'
      },
      {
        click: () => {
          shell.openExternal(currentSite.admin_url);
        },
        label: 'Go to Admin'
      },
      {
        label: 'Deploys',
        submenu: this.getDeploysSubmenu(deploys, currentSite)
      },
      {
        click: async () => {
          this.fetchData(async () => {
            await this.apiClient.createSiteBuild(currentSiteId);
          });
        },
        label: 'Trigger new deploy'
      },
      { type: 'separator' },
      { type: 'separator' },
      {
        label: 'Settings',
        submenu: this.getSettingsSubmenu()
      },
      { type: 'separator' },
      { label: 'Quit Netlify Menubar', role: 'quit' }
    ]);

    menu.on('menu-will-show', () => (this.state.menuIsOpen = true));
    menu.on('menu-will-close', () => {
      this.state.menuIsOpen = false;
      // this needs a round on the main thread otherwise
      // the menu-reset will cancel click handlers
      setTimeout(() => this.render(), 0);
    });

    // avoid the menu to close in case the user has it open
    if (!this.state.menuIsOpen) {
      // tslint:disable-next-line
      console.log('UI: rerending menu');
      this.tray.setContextMenu(menu);
    }
  }
}
